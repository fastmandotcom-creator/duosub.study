//! Live session control: build the pipeline session and run it off the HTTP thread.
//!
//! The bridge owns exactly one live session at a time. Every transcript event produced by the
//! pipeline is forwarded into the [`EventBus`] as the bridge's own wire contract — `wisp_core`
//! types never cross the HTTP boundary.

use std::path::PathBuf;
use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
use std::time::{SystemTime, UNIX_EPOCH};

use wisp_core::audio::AudioSource;
use wisp_core::error::{Result, WispError};
use wisp_core::model::ModelFamily;
use wisp_core::model::ModelId;
use wisp_core::transcript::{AudioSourceKind, TranscriptEvent};
use wisp_engine_sherpa::{
    ParaformerEngine, SenseVoiceEngine, SileroSegmenter, SherpaLiveDiarizer, WhisperEngine,
};
use wisp_models::download::{DownloadConfig, HttpDownloader};
use wisp_models::{builtin_catalog, FsModelStore};
use wisp_pipeline::pipeline::DEFAULT_SILENCE_HANGOVER;
use wisp_pipeline::{
    EnergySegmenter, EnergyVad, LiveStream, Segmenter, Session, Transcriber, Vad,
};

use crate::bus::EventBus;
use crate::config::BridgeConfig;
use crate::contract::{
    BridgeEvent, EventBody, HealthResponse, PollResponse, SessionStatus, SessionMeta, StartRequest,
    segment_payload,
};

/// A resolved ASR model: its on-disk directory plus the catalog family the engine dispatches on.
pub struct AsrModel {
    dir: PathBuf,
    family: ModelFamily,
    /// The catalog model id (e.g. "sense-voice" / "whisper-medium").
    id: String,
    /// Exact on-disk file names declared by the catalog descriptor (e.g. "medium-tokens.txt").
    /// Whisper ships PREFIXED names, so hardcoding "tokens.txt" fails the sherpa recognizer —
    /// the descriptor is the single source of truth for what is on disk.
    files: Vec<String>,
}

impl AsrModel {
    /// Resolves the model files for the configured family, downloading when `auto_download` is on.
    /// The download is the bridge's one slow startup path — a missing model with auto-download off
    /// is a loud startup error, never a silent no-ASR session.
    pub fn resolve(cfg: &BridgeConfig) -> Result<Self> {
        Self::resolve_family(cfg, &cfg.family)
    }

    /// Resolves the model files for an explicit family string (the runtime model-switch path:
    /// `POST /models/select`). Downloads when `auto_download` is on; fails loud otherwise.
    pub fn resolve_family(cfg: &BridgeConfig, family: &str) -> Result<Self> {
        let id_str = crate::config::model_id_for_family(family);
        let id = ModelId(id_str.to_owned());
        let catalog = builtin_catalog();
        // Resolve the family + the exact on-disk file names up front (Copy out of the catalog) so
        // the catalog can then move into the store.
        let descriptor = catalog
            .iter()
            .find(|d| d.id == id)
            .ok_or_else(|| WispError::Model(format!("unknown model {id_str}")))?;
        let family = descriptor.family;
        let files: Vec<String> = descriptor.files.iter().map(|f| f.name.clone()).collect();

        let downloader = HttpDownloader::with_config(DownloadConfig::default())
            .map_err(|e| WispError::Model(format!("download config: {e}")))?;
        let store = FsModelStore::new(&cfg.models_dir, catalog, Box::new(downloader));

        // ensure_with_progress is idempotent: a fully-installed model returns immediately (the
        // ~µs "ready" path), only a genuinely missing/partial install downloads.
        let dir = if let Some(local) = store.local_path(&id) {
            local
        } else if cfg.auto_download {
            let started = SystemTime::now();
            let path = store.ensure_with_progress(&id, &mut |downloaded, total| {
                // Log roughly every 20% so a multi-GB fetch doesn't spam stderr.
                if total > 0 && downloaded >= total / 5 {
                    eprintln!(
                        "duosub-bridge: downloading model {id_str}: {} MiB / {} MiB",
                        downloaded / 1_048_576,
                        total / 1_048_576
                    );
                }
            })?;
            eprintln!(
                "duosub-bridge: model {id_str} ready at {path:?} in {:?}",
                started.elapsed().unwrap_or_default()
            );
            path
        } else {
            store.local_path(&id).ok_or_else(|| WispError::Model(format!(
                "model {id_str} not installed under {} and auto-download is off \
                 (set DUOSUB_AUTODOWNLOAD=1 to allow the bridge to fetch it)",
                cfg.models_dir.display()
            )))?
        };

        Ok(Self {
            dir,
            family,
            id: id_str.to_owned(),
            files,
        })
    }

    /// Resolve one engine file by role from the catalog's declared names, falling back to the
    /// legacy substring scan. Fails loud with the directory listing so a missing asset is
    /// diagnosable instead of surfacing as an opaque sherpa "tokens does not exist" abort.
    fn engine_file(&self, role: &str) -> Result<PathBuf> {
        let matches = |name: &str| -> bool {
            let lower = name.to_lowercase();
            match role {
                "tokens" => lower.ends_with("tokens.txt"),
                "encoder" => lower.contains("encoder"),
                "decoder" => lower.contains("decoder"),
                _ => lower.ends_with(".onnx"),
            }
        };
        if let Some(name) = self.files.iter().find(|n| matches(n)) {
            let path = self.dir.join(name);
            if path.is_file() {
                return Ok(path);
            }
        }
        if let Ok(entries) = std::fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if matches(&name) && entry.path().is_file() {
                    return Ok(entry.path());
                }
            }
        }
        let present: Vec<String> = std::fs::read_dir(&self.dir)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        Err(WispError::Model(format!(
            "model {} has no {role} file in {} (present: {present:?})",
            self.id,
            self.dir.display()
        )))
    }

    /// The catalog model id this instance serves (e.g. "sense-voice").
    pub fn id_str(&self) -> &str {
        &self.id
    }

    /// The languages this model family can actually transcribe, plus "auto".
    /// - SenseVoice is trained on zh/en/ja/ko/yue only — anything else (e.g. Vietnamese) is
    ///   silently misrecognized, so the UI must treat it as a closed set.
    /// - Whisper (medium) is multilingual (~99 languages, Vietnamese included).
    /// This is the bridge's capability contract — the extension validates a picked language
    /// against it and fails loud instead of serving garbled text.
    pub fn supported_languages(&self) -> &'static [&'static str] {
        match self.family {
            ModelFamily::SenseVoice => &["auto", "zh", "en", "ja", "ko", "yue"],
            ModelFamily::Whisper => &[
                "auto", "vi", "en", "zh", "ja", "ko", "yue", "es", "fr", "de", "ru",
            ],
            // The bridge does not serve these families yet (see build_engine), so no language
            // beyond "auto" is guaranteed.
            _ => &["auto"],
        }
    }

    /// Builds the ASR engine for this model directory, dispatched on the catalog family.
    /// Mirrors the app's per-family file discovery (encoder/decoder/model .onnx + tokens.txt).
    pub fn build_engine(&self, language: &str) -> Result<Box<dyn wisp_core::engine::AsrEngine>> {
        let dir = &self.dir;

        match self.family {
            ModelFamily::SenseVoice => {
                // SenseVoice's model file is the only .onnx that is not encoder/decoder.
                let model_file = self.engine_file("model")?;
                let tokens = self.engine_file("tokens")?;
                Ok(Box::new(SenseVoiceEngine::new(&model_file, &tokens, language)?))
            }
            ModelFamily::Whisper => {
                let encoder = self.engine_file("encoder")?;
                let decoder = self.engine_file("decoder")?;
                let tokens = self.engine_file("tokens")?;
                // Cantonese tokens exist only in Whisper large-v3; smaller sizes fall back to zh
                // (same policy as the app).
                let language = if language == "yue" && !dir.to_string_lossy().contains("large-v3") {
                    "zh"
                } else {
                    language
                };
                Ok(Box::new(WhisperEngine::new(&encoder, &decoder, &tokens, language)?))
            }
            ModelFamily::Paraformer => {
                let model_file = self.engine_file("model")?;
                let tokens = self.engine_file("tokens")?;
                Ok(Box::new(ParaformerEngine::new(&model_file, &tokens)?))
            }
            other => Err(WispError::Engine(format!(
                "bridge does not serve model family {other:?} yet"
            ))),
        }
    }
}

/// Did the caller explicitly ask for this source (as opposed to "whatever you can open")?
fn explicitly_requested(requested: &[String], source: &str) -> bool {
    requested.iter().any(|s| s == source)
}

/// Per-stream audio sources the bridge knows how to open, tagged with their source kind.
/// Both streams share one engine (the session's shared transcriber), so mic + system get a single
/// coherent language and rolling context — the app's dual-stream design.
fn open_streams(requested: &[String]) -> Result<Vec<(Box<dyn AudioSource>, AudioSourceKind)>> {
    let want_mic = requested.is_empty() || requested.iter().any(|s| s == "microphone");
    let want_system = requested.is_empty() || requested.iter().any(|s| s == "system");

    let mut streams: Vec<(Box<dyn AudioSource>, AudioSourceKind)> = Vec::new();

    // An EXPLICITLY requested source must either open or fail the session. Silently degrading
    // (system audio denied → quietly record the microphone) is what made the UI claim it was
    // "listening" while capturing the wrong thing entirely.
    if want_mic {
        match wisp_audio::MicSource::from_default() {
            Ok(src) => streams.push((Box::new(src), AudioSourceKind::Microphone)),
            Err(e) => {
                eprintln!("duosub-bridge: microphone capture unavailable: {e:?}");
                if explicitly_requested(requested, "microphone") {
                    return Err(WispError::Audio(format!(
                        "microphone capture failed: {e:?} — allow microphone access for this app in System Settings → Privacy & Security → Microphone"
                    )));
                }
            }
        }
    }
    if want_system {
        match open_system_source() {
            Ok(src) => streams.push((Box::new(src), AudioSourceKind::System)),
            Err(e) => {
                eprintln!("duosub-bridge: system audio capture unavailable: {e:?}");
                if explicitly_requested(requested, "system") {
                    request_system_audio_permission();
                    return Err(WispError::Audio(format!(
                        "system audio capture failed: {e:?} — System Settings just opened: enable \"DuoSub Bridge\" under Privacy & Security → Screen & System Audio Recording. No restart needed; the next session picks the grant up"
                    )));
                }
            }
        }
    }

    if streams.is_empty() {
        return Err(WispError::Audio(
            "no audio source available (neither microphone nor system audio could open)".to_owned(),
        ));
    }
    Ok(streams)
}

/// System/meeting audio capture — ScreenCaptureKit on macOS, WASAPI loopback on Windows.
/// The source is built lazily at session start; the health check reports only what the host
/// supports (compile-time), so probing permission state is the caller's problem, not ours.
#[cfg(target_os = "macos")]
fn open_system_source() -> std::result::Result<wisp_screencapture::ScreenCaptureSource, WispError> {
    wisp_screencapture::ScreenCaptureSource::new()
}

#[cfg(target_os = "windows")]
fn open_system_source() -> std::result::Result<wisp_loopback::WasapiLoopbackSource, WispError> {
    wisp_loopback::WasapiLoopbackSource::new()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn open_system_source() -> std::result::Result<(), WispError> {
    Err(WispError::Audio(
        "system audio capture is macOS (ScreenCaptureKit) / Windows (WASAPI loopback) only"
            .to_owned(),
    ))
}

/// A started live session and its pipeline handle.
pub struct LiveSession {
    pub id: String,
    pub language: String,
    pub segment_count: Arc<AtomicU64>,
    session: Option<Session>,
}

impl LiveSession {
    pub fn status(&self) -> SessionStatus {
        SessionStatus {
            active: true,
            session_id: Some(self.id.clone()),
            language: Some(self.language.clone()),
            segment_count: self.segment_count.load(Ordering::Relaxed),
        }
    }
}

/// Starts a live transcription session, wiring the requested audio streams through the engine.
pub fn start_session(
    cfg: &BridgeConfig,
    bus: &EventBus,
    model: &AsrModel,
    req: &StartRequest,
) -> Result<LiveSession> {
    let language = if req.language.trim().is_empty() {
        "auto".to_owned()
    } else {
        req.language.trim().to_owned()
    };

    let engine = model.build_engine(&language)?;
    let mut transcriber = Transcriber::new(engine, AudioSourceKind::System);

    if let Some(dir) = &cfg.diarize {
        match SherpaLiveDiarizer::new(&dir.join("embedding.onnx")) {
            Ok(diarizer) => transcriber = transcriber.with_diarizer(Box::new(diarizer)),
            Err(e) => {
                eprintln!("duosub-bridge: live diarizer load failed ({e:?}); skipping speaker labels")
            }
        }
    }

    let streams = open_streams(&req.sources)?;
    let stream_names: Vec<String> = streams
        .iter()
        .map(|(_, kind)| match kind {
            AudioSourceKind::Microphone => "microphone".to_owned(),
            AudioSourceKind::System => "system".to_owned(),
            _ => "other".to_owned(),
        })
        .collect();

    let live_streams: Vec<LiveStream> = streams
        .into_iter()
        .map(|(source, kind)| LiveStream {
            segmenter: build_segmenter(cfg, kind),
            source,
            denoiser: None,
            kind,
        })
        .collect();

    let session_id = uuid::Uuid::now_v7().to_string();
    let counter = Arc::new(AtomicU64::new(0));
    let counter_sink = Arc::clone(&counter);
    let bus_sink = bus.clone();
    let id_sink = session_id.clone();
    let language_sink = language.clone();

    // The pipeline sink is the ONLY place core segments meet the wire contract.
    let sink: wisp_pipeline::EventSink = Box::new(move |event| {
        if let TranscriptEvent::Segment(segment) = event {
            counter_sink.fetch_add(1, Ordering::Relaxed);
            let body = EventBody::Segment(segment_payload(&id_sink, &segment, &language_sink));
            bus_sink.publish(&BridgeEvent {
                seq: 0,
                ts: now_ms(),
                body,
            });
        }
    });

    let session = Session::spawn_live_multi(live_streams, transcriber, sink);

    bus.publish(&BridgeEvent {
        seq: 0,
        ts: now_ms(),
        body: EventBody::SessionStarted(SessionMeta {
            session_id: session_id.clone(),
            language: language.clone(),
            sources: stream_names.clone(),
        }),
    });

    eprintln!(
        "duosub-bridge: session {session_id} started (language={language}, sources={stream_names:?})"
    );

    Ok(LiveSession {
        id: session_id,
        language,
        segment_count: counter,
        session: Some(session),
    })
}

/// Stops the session, joins its pipeline threads, and publishes the `session_stopped` event.
pub fn stop_session(bus: &EventBus, session: &mut LiveSession) {
    if let Some(wisp_session) = session.session.take() {
        if let Err(e) = wisp_session.stop() {
            eprintln!("duosub-bridge: session stop reported: {e:?}");
        }
    }
    bus.publish(&BridgeEvent {
        seq: 0,
        ts: now_ms(),
        body: EventBody::SessionStopped {
            session_id: session.id.clone(),
            segment_count: session.segment_count.load(Ordering::Relaxed),
        },
    });
    eprintln!("duosub-bridge: session {} stopped", session.id);
}

/// Publishes an operational error to live subscribers so a degraded state is visible, not silent.
pub fn publish_error(bus: &EventBus, message: &str) {
    bus.publish(&BridgeEvent {
        seq: 0,
        ts: now_ms(),
        body: EventBody::Error {
            message: message.to_owned(),
        },
    });
}

/// Silero VAD when configured and loadable, otherwise the dependency-free energy gate — the same
/// fallback the app uses so capture keeps working with no VAD asset.
fn build_segmenter(cfg: &BridgeConfig, kind: AudioSourceKind) -> Box<dyn Segmenter> {
    if let Some(path) = &cfg.silero {
        if let Ok(seg) = SileroSegmenter::new(path) {
            return Box::new(seg);
        }
        eprintln!("duosub-bridge: Silero VAD load failed ({path:?}); using energy gate");
    }
    let vad: Box<dyn Vad> = match kind {
        // The app uses a slightly louder floor for the mic than for the mixed stream.
        AudioSourceKind::Microphone => Box::new(EnergyVad::new(0.012)),
        _ => Box::new(EnergyVad::default()),
    };
    Box::new(EnergySegmenter::new(vad, DEFAULT_SILENCE_HANGOVER))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Builds the poll-fallback response for a `since` marker, with the ring window so a client can
/// detect when its marker has aged out (gap → resync).
pub fn poll_response(bus: &EventBus, since: u64) -> PollResponse {
    PollResponse {
        since,
        events: bus.replay_after(since),
        oldest_in_ring: bus.oldest_seq(),
        latest_seq: bus.latest_seq(),
    }
}

/// `GET /health` body — built per request so the active session stays current.
pub fn health(model: &AsrModel, active: Option<SessionStatus>) -> HealthResponse {
    HealthResponse {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
        family: model.id_str().to_owned(),
        model_id: model.id_str().to_owned(),
        // Model files installed on disk (no download needed).
        model_ready: true,
        sources: available_sources(),
        supported_languages: model.supported_languages().iter().map(|s| s.to_string()).collect(),
        system_audio: system_audio_authorization(),
        session: active,
    }
}

/// Runtime OS authorization for system-audio capture. On macOS the ScreenCaptureKit capture is
/// gated by the TCC "Screen & System Audio Recording" permission, which the UI must be able to
/// explain before a session starts (a denied permission is invisible in every other field).
#[cfg(target_os = "macos")]
pub fn system_audio_authorization() -> &'static str {
    // Cheap, non-blocking, never prompts: exactly what a health poll may call.
    if core_graphics::access::ScreenCaptureAccess::default().preflight() {
        "granted"
    } else {
        "denied"
    }
}

#[cfg(not(target_os = "macos"))]
pub fn system_audio_authorization() -> &'static str {
    "not-required"
}

/// Best-effort OS permission request: when system capture is denied, nudge macOS to open System
/// Settings at the Screen Recording page with this app pre-listed, so the user only flips a toggle.
/// Fire-and-forget by design (a background LaunchAgent cannot block on a user dialog).
#[cfg(target_os = "macos")]
pub fn request_system_audio_permission() {
    let already = system_audio_authorization() == "granted";
    if already {
        return;
    }
    let granted = core_graphics::access::ScreenCaptureAccess::default().request();
    eprintln!(
        "duosub-bridge: Screen Recording grant flow triggered (preflight={}, prompt result={}) — the user flips the toggle in System Settings",
        system_audio_authorization(),
        granted
    );
}

#[cfg(not(target_os = "macos"))]
pub fn request_system_audio_permission() {}

/// Sources this host can open, by COMPILE-TIME capability. Deliberately never probes the real
/// audio stack here: first `cpal`/`ScreenCaptureKit` use triggers OS permission prompts and can
/// wedge for seconds, which would stall a cheap `/health` poll. Runtime open success/failure is
/// surfaced per-session by `start_session` (an explicitly requested source that cannot open fails
/// the session with an actionable error, and
/// zero streams is a loud 503), so the health report stays prompt-free and instant.
pub fn available_sources() -> Vec<String> {
    let mut out = vec!["microphone".to_owned()];
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    out.push("system".to_owned());
    out
}
