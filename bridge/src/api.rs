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
    AsrModel, LiveSession, health as build_health, poll_response, start_session, stop_session,
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

    let mut slot = session_slot().lock().unwrap();
    slot.starting = false; // a stop during an in-flight start clears the reservation.
    match slot.session.take() {
        Some(mut session) => {
            stop_session(&state.bus, &mut session);
            json_ok(json!({ "stopped": true }))
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

    if wants_sse {
        let bus = state.bus.clone();
        let since = since.unwrap_or(0);
        axum::response::sse::Sse::new(event_stream(bus, since))
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

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/sessions/start", post(sessions_start))
        .route("/sessions/stop", post(sessions_stop))
        .route("/models/select", post(models_select))
        .route("/events", get(events))
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
