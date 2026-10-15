//! The bridge's OWN wire contract (SSE + poll + health + session payloads).
//!
//! These types are the single source of truth between Wisp and the Live-Code extension's Mode B
//! (`wispLocalCaptionProducer`). They deliberately re-export nothing from `wisp_core` — a field
//! rename in Wisp upstream must not change the bridge wire format; the golden test below pins the
//! bytes.

use serde::Serialize;

use wisp_core::transcript::TranscriptSegment;

/// One SSE frame / poll element. `seq` is monotonic per bridge process; `ts` is epoch millis.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BridgeEvent {
    pub seq: u64,
    pub ts: u64,
    #[serde(flatten)]
    pub body: EventBody,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventBody {
    /// A live ASR segment, still revising (`final=false`) or committed (`final=true`).
    Segment(SegmentPayload),
    /// A session was started on the bridge.
    SessionStarted(SessionMeta),
    /// A session was stopped.
    SessionStopped {
        session_id: String,
        /// Segments emitted during the session.
        segment_count: u64,
    },
    /// Operational error surfaced to clients.
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SessionMeta {
    pub session_id: String,
    pub language: String,
    pub sources: Vec<String>,
}

/// One transcript segment — the row a consumer upserts per utterance.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SegmentPayload {
    pub session_id: String,
    /// Stable per-utterance id (partial and final share it — consumers update one row in place).
    pub segment_id: u64,
    pub text: String,
    /// Committed (true) or still revising (false). JSON key stays `final` for consumers.
    #[serde(rename = "final")]
    pub is_final: bool,
    /// Diarized speaker index, `null` when diarization is off/unfinished.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<u32>,
    /// Which stream produced the segment.
    pub source: &'static str,
    /// Engine confidence in `[0.0, 1.0]` when the engine reports one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    /// Session-started ASR language (`"auto"` or a code) — context, not a per-utterance LID.
    pub language: String,
    /// Start offset in ms from session start.
    pub t0_ms: u64,
    /// End offset in ms from session start.
    pub t1_ms: u64,
}

/// Maps one core segment to the wire payload. Pure — the golden test pins its bytes.
pub fn segment_payload(
    session_id: &str,
    segment: &TranscriptSegment,
    language: &str,
) -> SegmentPayload {
    SegmentPayload {
        session_id: session_id.to_owned(),
        segment_id: segment.id,
        text: segment.text.clone(),
        is_final: matches!(
            segment.status,
            wisp_core::transcript::SegmentStatus::Final
        ),
        speaker: segment.speaker.map(|s| s.0),
        source: match segment.source {
            wisp_core::transcript::AudioSourceKind::Microphone => "microphone",
            wisp_core::transcript::AudioSourceKind::System => "system",
            wisp_core::transcript::AudioSourceKind::File => "file",
            // #[non_exhaustive]: an unknown kind is an honest "other", never a dropped event.
            _ => "other",
        },
        confidence: segment.confidence,
        language: language.to_owned(),
        t0_ms: segment.start.as_millis() as u64,
        t1_ms: segment.end.as_millis() as u64,
    }
}

/// `GET /health` response.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HealthResponse {
    pub ok: bool,
    pub version: &'static str,
    pub family: String,
    pub model_id: String,
    /// Model files installed on disk (no download needed).
    pub model_ready: bool,
    /// Audio sources actually constructed for the last/next session.
    pub sources: Vec<String>,
    pub session: Option<SessionStatus>,
}

/// Live session status inside the health payload.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SessionStatus {
    pub active: bool,
    pub session_id: Option<String>,
    pub language: Option<String>,
    pub segment_count: u64,
}

/// `GET /events?since=<seq>` response (poll fallback). `oldest_in_ring`/`latest_seq` let a
/// client detect when its `since` has aged out of the replay window (gap → resync via health).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PollResponse {
    pub since: u64,
    pub events: Vec<BridgeEvent>,
    /// Oldest seq still replayable, or `None` when the ring is empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_in_ring: Option<u64>,
    pub latest_seq: u64,
}

/// `POST /sessions/start` request body.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct StartRequest {
    /// ASR language: `"auto"` (engine auto-detect) or a pinned code.
    #[serde(default = "default_language")]
    pub language: String,
    /// Mic/system streams to open. Empty = open everything available.
    #[serde(default)]
    pub sources: Vec<String>,
}

fn default_language() -> String {
    "auto".to_owned()
}

/// Error envelope for all non-2xx responses.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use wisp_core::transcript::{AudioSourceKind, SegmentStatus, TranscriptSegment};

    /// Golden wire bytes for one final segment — the extension's producer is written against these
    /// exact JSON bytes, so any accidental rename/shape change fails here first. The enum is
    /// internally tagged (`"kind":"segment"` inlines the payload fields).
    const GOLDEN_FINAL_SEGMENT: &str = r#"{"seq":42,"ts":1734567890123,"kind":"segment","session_id":"s1","segment_id":7,"text":"hello world","final":true,"speaker":2,"source":"system","confidence":0.91,"language":"en","t0_ms":1000,"t1_ms":3500}"#;

    fn final_segment() -> TranscriptSegment {
        let mut s = TranscriptSegment::new(
            7,
            "hello world",
            Duration::from_millis(1000)..Duration::from_millis(3500),
            AudioSourceKind::System,
        );
        s.status = SegmentStatus::Final;
        s.speaker = Some(wisp_core::transcript::SpeakerId(2));
        s.confidence = Some(0.91);
        s
    }

    #[test]
    fn golden_final_segment_bytes() {
        let event = BridgeEvent {
            seq: 42,
            ts: 1_734_567_890_123,
            body: EventBody::Segment(segment_payload("s1", &final_segment(), "en")),
        };
        let json = serde_json::to_string(&event).expect("serialize");
        assert_eq!(json, GOLDEN_FINAL_SEGMENT);
    }

    #[test]
    fn partial_segment_serializes_final_false_and_omits_null_fields() {
        let s = TranscriptSegment::new(
            3,
            "hi",
            Duration::from_millis(10)..Duration::from_millis(90),
            AudioSourceKind::Microphone,
        );
        let json =
            serde_json::to_string(&segment_payload("s9", &s, "auto")).expect("serialize");
        let v: serde_json::Value = serde_json::from_str(&json).expect("parse");
        assert_eq!(v["final"], false);
        assert_eq!(v["source"], "microphone");
        assert!(v.get("speaker").is_none(), "null speaker must be omitted");
        assert!(v.get("confidence").is_none(), "null confidence must be omitted");
        assert_eq!(v["language"], "auto");
    }
}
