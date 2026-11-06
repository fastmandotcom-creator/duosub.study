//! Loopback HTTP API: auth, health, session control, and the SSE transcript stream.
//!
//! Transport-only: all pipeline/state logic lives in `session.rs`, so this file is just axum
//! plumbing over the bridge's wire contract.

use std::sync::OnceLock;
use std::sync::Mutex;
use std::time::Duration;

use axum::body::Body;
use axum::extract::Query;
use axum::extract::State;
use axum::http::StatusCode;
use axum::http::header;
use axum::response::Response;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::routing::post;
use axum::serve as axum_serve;
use axum::Router;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;

use crate::bus::EventBus;
use crate::config::BridgeConfig;
use crate::contract::{BridgeEvent, HealthResponse, PollResponse, StartRequest};
use crate::session::{
    AsrModel, LiveSession, health as build_health, poll_response, open_capture_settings, start_session, stop_session,
};

/// Shared server state. The bridge serves exactly one live session at a time (documented
/// limitation of a local single-user tool); the slot is process-global so any handler sees it.
#[derive(Clone)]
pub struct AppState {
    pub cfg: BridgeConfig,
    pub bus: EventBus,
    pub model: std::sync::Arc<std::sync::RwLock<AsrModel>>,
}

/// The process-wide session slot. `session` is the running pipeline; `starting` is set while the
/// (slow, blocking) engine build + audio open is in flight so that a concurrent start sees 409 and
/// a concurrent health/stop can answer from state WITHOUT waiting on the busy lock.
static SESSION: OnceLock<Mutex<SlotState>> = OnceLock::new();

#[derive(Default)]
struct SlotState {
    session: Option<LiveSession>,
    /// A session start is in flight (engine build / audio open).
    starting: bool,
}

fn session_slot() -> &'static Mutex<SlotState> {
    SESSION.get_or_init(|| Mutex::new(SlotState::default()))
}

// ---------------------------------------------------------------------------
// Orphan reaper - a session with nobody listening must not keep the machine busy
// ---------------------------------------------------------------------------
//
// The bridge holds ONE session slot and, while it is held, it keeps capturing system
// audio + the microphone and runs the ASR engine on every utterance. If the client
// disappears (browser closed, tab crashed, the lid slept), nothing called
// `/sessions/stop` and the session ran on forever: measured 6.7 CPU cores + 7.2 GB RSS
// while health reported an idle session - exactly the "may rat lag" report.
//
// The extension stops the session when its Live Caption viewer closes, but a
// bridge-side backstop is the only thing that covers a client that vanishes without a
// graceful shutdown. Rule: a session with NO live SSE subscriber AND no `/events`
// request for the whole window is an orphan - stop it and release the engine. A live
// subscriber (a meeting in progress) is never reaped, however long the silence.

/// Live `/events` SSE connections. Held by a guard dropped with the response body.
static SSE_SUBSCRIBERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// Wall-clock ms of the most recent `/events` request (SSE connect or poll), 0 = never.
static LAST_EVENTS_REQUEST_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// Default orphan window: generous enough to ride out an SSE blip or a sleeping lid
/// (the extension reconnects within seconds), short enough that an abandoned session
/// stops burning cores almost immediately.
const DEFAULT_IDLE_REAP_MS: i64 = 180_000;
const IDLE_REAP_ENV: &str = "DUOSUB_SESSION_IDLE_REAP_MS";

fn idle_reap_window_ms() -> i64 {
    std::env::var(IDLE_REAP_ENV)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|ms| *ms > 0)
        .unwrap_or(DEFAULT_IDLE_REAP_MS)
}

fn now_ms_i64() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Drops the live-subscriber count with the SSE response body, so a client that dies
/// mid-stream is accounted for without waiting for a timeout.
struct SseSubscriberGuard;

impl Drop for SseSubscriberGuard {
    fn drop(&mut self) {
        SSE_SUBSCRIBERS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Reap an orphaned session: no SSE subscriber and no `/events` traffic for the whole
/// window. Returns the reaped session id when it acted.
fn reap_orphaned_session(bus: &EventBus) -> Option<String> {
    use std::sync::atomic::Ordering;

    let window = idle_reap_window_ms();
    let subscribers = SSE_SUBSCRIBERS.load(Ordering::SeqCst);
    if subscribers > 0 {
        return None;
    }
    let last_seen = LAST_EVENTS_REQUEST_MS.load(Ordering::SeqCst);
    let now = now_ms_i64();
    // Guard with `saturating_sub` so a clock that reads as "never" simply compares as very old;
    // `spawn_idle_reaper` seeds the baseline so a fresh process always serves the full window
    // before its first reap (no false kill while a client is still mid-subscribe).
    if now.saturating_sub(last_seen) < window {
        return None;
    }

    let mut slot = session_slot().lock().ok()?;
    let id = slot.session.as_ref()?.id.clone();
    stop_session(bus, slot.session.as_mut()?);
    eprintln!(
        "duosub-bridge: session {id} reaped - no live caption viewer for {}s (nobody listening; \
         capture + ASR engine released)",
        window / 1000
    );
    Some(id)
}

/// Spawns the periodic orphan check. Cheap: atomic reads per tick unless a session runs.
fn spawn_idle_reaper(state: &AppState) {
    let bus = state.bus.clone();
    // Seed the liveness baseline: a freshly booted bridge serves the whole window before its
    // first reap decision, so a client that starts a session and subscribes a beat later is
    // never killed as a false orphan.
    LAST_EVENTS_REQUEST_MS.store(now_ms_i64(), std::sync::atomic::Ordering::SeqCst);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(15));
        loop {
            tick.tick().await;
            reap_orphaned_session(&bus);
        }
    });
}

/// Token check shared by every route (Authorization header or `?token=` query fallback —
/// the query form exists so the user can also check with a bare browser URL).
/// An EMPTY expected token means auth is OFF (the loopback bind is the boundary; a
/// personal on-device tool does not need a per-startup token). Opt-in auth = set
/// `DUOSUB_TOKEN` (or keep a non-empty token file).
fn authorized(headers: &axum::http::HeaderMap, query_token: Option<&str>, expected: &str) -> bool {
    let expected = expected.trim();
    if expected.is_empty() {
        return true;
    }
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|v| v.trim());
    bearer == Some(expected) || query_token.map(|t| t.trim()) == Some(expected)
}

async fn unauthenticated() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        json!({ "error": "missing or invalid token" }).to_string(),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/// `GET /health` — bridge liveness + what a session start would use.
async fn health(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(q): Query<HealthQuery>,
) -> Response {
    if !authorized(&headers, q.token.as_deref(), &state.cfg.token) {
        return unauthenticated().await;
    }
    // Read the slot briefly; the starting flag lets us report "session not up yet" without blocking
    // on the in-flight engine build (which holds the model read lock, not the slot, so /health stays
    // responsive even while a whisper session is being built).
    let status = {
        let slot = session_slot().lock().unwrap();
        slot.session.as_ref().map(|s| s.status())
    };
    let model = state.model.read().unwrap();
    let body: HealthResponse = build_health(&model, status);
    json_ok(serde_json::to_value(&body).unwrap_or_default())
}

#[derive(Deserialize)]
struct HealthQuery {
    token: Option<String>,
}

/// `POST /sessions/start` — `{language, sources?}` → one live session.
async fn sessions_start(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(q): Query<StartQuery>,
    axum::Json(body): axum::Json<StartRequest>,
) -> Response {
    if !authorized(&headers, q.token.as_deref(), &state.cfg.token) {
        return unauthenticated().await;
    }

    // A session start IS proof that a client is present: reset the orphan window so a freshly
    // started session always gets its full grace period before the reaper can judge it. Without
    // this, a long-lived bridge could reap a session in the sliver between `/sessions/start`
    // returning and the client's `/events` subscribe landing.
    LAST_EVENTS_REQUEST_MS.store(now_ms_i64(), std::sync::atomic::Ordering::SeqCst);

    // Reserve the slot atomically, then release it: the engine build + audio open is slow and
    // blocking, so it must NOT hold the slot lock (a held lock would wedge /health and /stop,
    // which is exactly the P0 observed — a whisper start stalls every other endpoint).
    {
        let mut slot = session_slot().lock().unwrap();
        if slot.session.is_some() || slot.starting {
            return json_error(
                StatusCode::CONFLICT,
                "a session is already running or starting; stop it first (POST /sessions/stop)",
            );
        }
        slot.starting = true;
    }

    // Run the blocking engine build + stream open on the blocking pool so it can't stall the async
    // HTTP runtime. The model read lock is taken INSIDE the task (a std RwLock on the blocking pool
    // is fine) — a /models/select racing the build simply means the session starts on whichever
    // model is active at build time, which is the app's existing behavior.
    let cfg = state.cfg.clone();
    let bus = state.bus.clone();
    let model = state.model.clone();
    let request = body.clone();
    let build = tokio::task::spawn_blocking(move || {
        if request.mode == "capture" {
            // Raw PCM forwarding: no ASR engine, no model file read (the model lock is never
            // taken — a capture session must start even while a model download is in flight).
            return crate::session::start_capture_session(&cfg, &bus, &request);
        }
        let guard = model.read().unwrap();
        start_session(&cfg, &bus, &guard, &request)
    });
    let outcome = build.await;

    match outcome {
        Ok(Ok(session)) => {
            let id = session.id.clone();
            let mut slot = session_slot().lock().unwrap();
            slot.session = Some(session);
            slot.starting = false;
            json_created(json!({ "started": true, "sessionId": id }))
        }
        Ok(Err(e)) => {
            session_slot().lock().unwrap().starting = false;
            crate::session::publish_error(&state.bus, &format!("session start failed: {e:?}"));
            json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("session start failed: {e:?}"),
            )
        }
        Err(join) => {
            session_slot().lock().unwrap().starting = false;
            json_error(StatusCode::SERVICE_UNAVAILABLE, &format!("session start task failed: {join:?}"))
        }
    }
}

#[derive(Deserialize)]
struct StartQuery {
    token: Option<String>,
}

/// `POST /sessions/stop` — stop the live session and join its pipeline threads.
async fn sessions_stop(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(q): Query<StartQuery>,
) -> Response {
    if !authorized(&headers, q.token.as_deref(), &state.cfg.token) {
        return unauthenticated().await;
    }

    // Take the session out of the slot under the lock, then stop it on the blocking pool OUTSIDE
    // the lock: a stuck SCK pipeline join (e.g. the monitor slept mid-session) must not hold the
    // slot lock — a held lock would wedge /health and /sessions/start (the P0 observed).
    let taken = {
        let mut slot = session_slot().lock().unwrap();
        slot.starting = false; // a stop during an in-flight start clears the reservation.
        slot.session.take()
    };
    match taken {
        Some(mut session) => {
            let bus = state.bus.clone();
            let join = tokio::task::spawn_blocking(move || stop_session(&bus, &mut session)).await;
            match join {
                Ok(()) => json_ok(json!({ "stopped": true })),
                Err(e) => {
                    json_error(StatusCode::SERVICE_UNAVAILABLE, &format!("session stop task failed: {e:?}"))
                }
            }
        }
        None => json_error(StatusCode::CONFLICT, "no active session"),
    }
}

#[derive(Deserialize)]
struct ModelSelectRequest {
    /// "auto" | "sense-voice" | "whisper-medium" (DUOSUB_FAMILY values; "auto" = sense-voice).
    family: String,
}

/// `POST /models/select` — `{family}` → resolve (and auto-download) that family's model and make
/// it the ACTIVE model for all subsequent sessions. This is how the UI switches between the
/// fast 5-language SenseVoice and the multilingual (incl. Vietnamese) Whisper-medium.
/// A live session is NOT interrupted: the switch takes effect on the next session start.
async fn models_select(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(q): Query<StartQuery>,
    axum::Json(body): axum::Json<ModelSelectRequest>,
) -> Response {
    if !authorized(&headers, q.token.as_deref(), &state.cfg.token) {
        return unauthenticated().await;
    }
    let family = body.family.trim().to_owned();
    // Resolve (and auto-download, a potentially multi-minute blocking I/O path) on the blocking
    // pool so a 900MB fetch can't stall the async HTTP runtime — the same P0 class as a session
    // build wedging /health. The model write-lock is taken only for the final swap, never across
    // the download, so /health's read-lock stays responsive the whole time.
    let cfg = state.cfg.clone();
    let model = state.model.clone();
    let family_task = family.clone();
    let task = tokio::task::spawn_blocking(move || AsrModel::resolve_family(&cfg, &family_task));
    match task.await {
        Ok(Ok(new_model)) => {
            let model_id = new_model.id_str().to_owned();
            let supported: Vec<String> = new_model.supported_languages().iter().map(|s| s.to_string()).collect();
            // Swap under the write lock so in-flight session starts observe a coherent model.
            let mut guard = model.write().unwrap();
            *guard = new_model;
            drop(guard);
            eprintln!("duosub-bridge: active model switched to {model_id}");
            json_ok(json!({
                "selected": true,
                "family": family,
                "model_id": model_id,
                "supported_languages": supported,
            }))
        }
        Ok(Err(e)) => {
            json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("model select failed ({family}): {e:?} — the model may not be downloadable"),
            )
        }
        Err(join) => json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            &format!("model select task failed: {join:?}"),
        ),
    }
}

/// `GET /events` — SSE when `Accept: text/event-stream`, else the poll fallback.
/// `Last-Event-ID` (SSE) or `?since=` (poll) resumes after the given seq.
async fn events(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(q): Query<EventsQuery>,
) -> Response {
    if !authorized(&headers, q.token.as_deref(), &state.cfg.token) {
        return unauthenticated().await;
    }

    let wants_sse = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/event-stream"));

    let since = q.since.or_else(|| {
        headers
            .get("last-event-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
    });

    // Any `/events` request is proof that a client is here: a poll refreshes the
    // reaper's liveness timestamp, an SSE connection also holds a subscriber slot for
    // as long as its body lives.
    LAST_EVENTS_REQUEST_MS.store(now_ms_i64(), std::sync::atomic::Ordering::SeqCst);

    if wants_sse {
        let bus = state.bus.clone();
        let since = since.unwrap_or(0);
        SSE_SUBSCRIBERS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let guard = SseSubscriberGuard;
        // The guard is moved INTO the stream closure, so it is dropped exactly when the
        // response body is dropped (client disconnect / server shutdown).
        let mut inner = Box::pin(event_stream(bus, since));
        let stream = futures_util::stream::poll_fn(move |cx| {
            // `_guard` is captured by the closure, so the subscriber slot is released
            // exactly when this stream (the response body) is dropped.
            let _guard = &guard;
            inner.as_mut().poll_next_unpin(cx)
        });
        axum::response::sse::Sse::new(stream)
            .keep_alive(axum::response::sse::KeepAlive::default().interval(Duration::from_secs(15)))
            .into_response()
    } else {
        let since = since.unwrap_or(0);
        let body: PollResponse = poll_response(&state.bus, since);
        json_ok(serde_json::to_value(&body).unwrap_or_default())
    }
}

#[derive(Deserialize)]
struct EventsQuery {
    /// Last seq received — resume marker for both transports.
    since: Option<u64>,
    token: Option<String>,
}

/// Merged stream: ring replay from `since`, then the live broadcast. The live half is driven by
/// `unfold` over `Receiver::recv`, so it needs no `Stream` impl on the receiver.
fn event_stream(
    bus: EventBus,
    since: u64,
) -> impl futures_core::Stream<
    Item = std::result::Result<axum::response::sse::Event, std::convert::Infallible>,
> {
    type Item = std::result::Result<axum::response::sse::Event, std::convert::Infallible>;
    let replay = futures_util::stream::iter(
        bus.replay_after(since)
            .into_iter()
            .map(|ev| Ok(to_sse_event(&ev)) as Item),
    );
    let live = futures_util::stream::unfold(bus.subscribe(), move |mut rx| async move {
        match rx.recv().await {
            // A live event: forward it. `recv` never returns a stream error here.
            Ok(ev) => Some((Ok(to_sse_event(&ev)) as Item, rx)),
            // Lag or shutdown: end the stream; the client re-subscribes with its last event id.
            Err(_) => None,
        }
    });
    replay.chain(live).boxed()
}

/// One wire event → an SSE frame (typed event name + JSON data + resume id).
fn to_sse_event(ev: &BridgeEvent) -> axum::response::sse::Event {
    use crate::contract::EventBody;
    let data = serde_json::to_string(ev).unwrap_or_default();
    let event_name = match &ev.body {
        EventBody::Segment(_) => "segment",
        EventBody::SessionStarted(_) | EventBody::SessionStopped { .. } => "session",
        EventBody::PcmFrame(_) => "pcm_frame",
        EventBody::Error { .. } => "error",
    };
    axum::response::sse::Event::default()
        .id(ev.seq.to_string())
        .event(event_name)
        .data(data)
}

// ---------------------------------------------------------------------------
// Router + server
// ---------------------------------------------------------------------------

/// `POST /permissions/open-settings` — opens the macOS pane with the capture toggle.
/// A button in the extension calls this because Chrome cannot open `x-apple:` URLs.
async fn permissions_open_settings(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(q): Query<HealthQuery>,
) -> Response {
    if !authorized(&headers, q.token.as_deref(), &state.cfg.token) {
        return unauthenticated().await;
    }
    if open_capture_settings() {
        json_ok(json!({ "opened": true }))
    } else {
        json_error(StatusCode::SERVICE_UNAVAILABLE, "could not open System Settings")
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/sessions/start", post(sessions_start))
        .route("/sessions/stop", post(sessions_stop))
        .route("/models/select", post(models_select))
        .route("/events", get(events))
        .route("/permissions/open-settings", post(permissions_open_settings))
        .layer(
            axum::middleware::from_fn(
                |req: axum::extract::Request, next: axum::middleware::Next| async move {
                    let mut res = next.run(req).await;
                    res.headers_mut().insert(
                        header::ACCESS_CONTROL_ALLOW_ORIGIN,
                        axum::http::HeaderValue::from_static("*"),
                    );
                    res.headers_mut().insert(
                        header::ACCESS_CONTROL_ALLOW_HEADERS,
                        axum::http::HeaderValue::from_static("authorization, content-type, accept"),
                    );
                    res
                },
            ),
        )
        .with_state(state)
}

/// Starts the loopback listener and serves until the process ends. Binds the configured
/// host (default `127.0.0.1`); anything non-loopback is an operator's explicit choice.
pub async fn serve(state: AppState) -> std::io::Result<()> {
    let host = state.cfg.host.parse::<std::net::IpAddr>().unwrap_or(std::net::Ipv4Addr::new(127, 0, 0, 1).into());
    let addr = std::net::SocketAddr::from((host, state.cfg.port));
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        // A busy port means TWO bridge instances (a GUI-launched copy vs the LaunchAgent, or a
        // stale install). Say exactly what to do — a bare OSError just crash-loops the agent.
        std::io::Error::new(
            e.kind(),
            format!(
                "cannot bind {addr} ({e}). Another DuoSub Bridge instance is already holding the port. \
                 Fix: launchctl kickstart -k gui/$(id -u)/com.duosub.bridge  (or re-run install.sh, which stops the old one)"
            ),
        )
    })?;
    spawn_idle_reaper(&state);
    let auth = if state.cfg.token.is_empty() { "no auth (loopback only)" } else { "token required" };
    eprintln!(
        "duosub-bridge: listening on http://{addr} · {auth} · models under {}",
        state.cfg.models_dir.display()
    );
    axum_serve(listener, router(state)).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn json_ok(value: serde_json::Value) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

fn json_created(value: serde_json::Value) -> Response {
    Response::builder()
        .status(StatusCode::CREATED)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

fn json_error(status: StatusCode, message: &str) -> Response {
    use crate::contract::ErrorResponse;
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_string(&ErrorResponse {
                error: message.to_owned(),
            })
            .unwrap_or_default(),
        ))
        .unwrap()
}
