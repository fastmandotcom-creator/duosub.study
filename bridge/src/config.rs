//! Wisp local-bridge crate: environment-variable configuration.
//!
//! Every knob is a process env var read once at startup (Wisp convention: the literal names are
//! pinned by tests so a rename can never silently break operators).

use std::env;
use std::path::PathBuf;

/// The bridge's HTTP listen port. Pinned literal — renaming breaks operator scripts.
pub const BRIDGE_HOST_ENV: &str = "DUOSUB_HOST";
/// The bridge's HTTP listen port. Pinned literal.
pub const BRIDGE_PORT_ENV: &str = "DUOSUB_PORT";
/// Where the per-startup auth token is written/read. Pinned literal.
pub const BRIDGE_TOKEN_FILE_ENV: &str = "DUOSUB_TOKEN_FILE";
/// Root directory the model store looks in for installed models. Pinned literal.
pub const BRIDGE_MODELS_DIR_ENV: &str = "DUOSUB_MODELS_DIR";
/// Model family to serve: "auto" | "sense-voice" | "whisper-medium". Pinned literal.
pub const BRIDGE_FAMILY_ENV: &str = "DUOSUB_FAMILY";
/// Path to a Silero VAD model (.onnx). Falls back to the energy gate when unset/absent. Pinned literal.
pub const BRIDGE_SILERO_ENV: &str = "DUOSUB_SILERO";
/// Directory holding `embedding.onnx` for live speaker diarization. Skipped when unset. Pinned literal.
pub const BRIDGE_DIARIZE_ENV: &str = "DUOSUB_DIARIZE";
/// Download missing ASR models automatically at session start. "1"/"true" = on (default), else off.
/// Pinned literal.
pub const BRIDGE_AUTODOWNLOAD_ENV: &str = "DUOSUB_AUTODOWNLOAD";

pub const DEFAULT_HOST: &str = "127.0.0.1";
/// Pinned default port — the extension's Mode B default URL points here.
pub const DEFAULT_PORT: u16 = 4499;
/// Default model root: ~/.duosub/models (the product data dir).
pub const DEFAULT_MODELS_DIR: &str = ".duosub/models";
/// Default family: the light multilingual SenseVoice (the app's macOS default live engine).
pub const DEFAULT_FAMILY: &str = "auto";

pub const FAMILY_SENSE_VOICE: &str = "sense-voice";
pub const FAMILY_WHISPER_MEDIUM: &str = "whisper-medium";

/// Catalog model id each bridge family serves.
pub fn model_id_for_family(family: &str) -> &str {
    if family == FAMILY_WHISPER_MEDIUM {
        "whisper-medium"
    } else {
        FAMILY_SENSE_VOICE
    }
}

#[derive(Debug, Clone)]
pub struct BridgeConfig {
    pub host: String,
    pub port: u16,
    pub token_file: PathBuf,
    pub token: String,
    pub models_dir: PathBuf,
    pub family: String,
    pub silero: Option<PathBuf>,
    pub diarize: Option<PathBuf>,
    pub auto_download: bool,
}

fn env_or(key: &str, default: &str) -> String {
    match env::var(key) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_owned(),
        _ => default.to_owned(),
    }
}

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

impl BridgeConfig {
    /// Reads configuration from the environment. The auth `token` is filled in by the binary after
    /// it is generated/loaded from the token file.
    pub fn from_env() -> Self {
        let token_file = env::var(BRIDGE_TOKEN_FILE_ENV)
            .map(PathBuf::from)
            .ok()
            .unwrap_or_else(|| home_dir().join(".duosub").join("token"));
        let models_dir = env::var(BRIDGE_MODELS_DIR_ENV)
            .map(PathBuf::from)
            .ok()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| home_dir().join(DEFAULT_MODELS_DIR));
        let family = env::var(BRIDGE_FAMILY_ENV).ok().filter(|v| !v.trim().is_empty());
        let auto_download = match env::var(BRIDGE_AUTODOWNLOAD_ENV).as_deref() {
            Err(_) => true,
            Ok(v) => !matches!(v.trim(), "0" | "false" | "no"),
        };

        Self {
            host: env_or(BRIDGE_HOST_ENV, DEFAULT_HOST),
            port: env::var(BRIDGE_PORT_ENV)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_PORT),
            token_file,
            token: String::new(), // filled in by the binary at startup
            models_dir,
            family: family.unwrap_or_else(|| DEFAULT_FAMILY.to_owned()),
            silero: env::var(BRIDGE_SILERO_ENV)
                .ok()
                .map(PathBuf::from)
                .filter(|p| p.is_file()),
            diarize: env::var(BRIDGE_DIARIZE_ENV)
                .ok()
                .map(PathBuf::from)
                .filter(|p| p.join("embedding.onnx").is_file()),
            auto_download,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_var_names_are_pinned() {
        // Renaming any of these silently breaks operator env setups — pin the literals.
        assert_eq!(BRIDGE_HOST_ENV, "DUOSUB_HOST");
        assert_eq!(BRIDGE_PORT_ENV, "DUOSUB_PORT");
        assert_eq!(BRIDGE_TOKEN_FILE_ENV, "DUOSUB_TOKEN_FILE");
        assert_eq!(BRIDGE_MODELS_DIR_ENV, "DUOSUB_MODELS_DIR");
        assert_eq!(BRIDGE_FAMILY_ENV, "DUOSUB_FAMILY");
        assert_eq!(BRIDGE_SILERO_ENV, "DUOSUB_SILERO");
        assert_eq!(BRIDGE_DIARIZE_ENV, "DUOSUB_DIARIZE");
        assert_eq!(BRIDGE_AUTODOWNLOAD_ENV, "DUOSUB_AUTODOWNLOAD");
        assert_eq!(DEFAULT_PORT, 4499);
    }

    #[test]
    fn family_maps_to_catalog_model_id() {
        assert_eq!(model_id_for_family(FAMILY_WHISPER_MEDIUM), "whisper-medium");
        assert_eq!(model_id_for_family(FAMILY_SENSE_VOICE), "sense-voice");
        assert_eq!(model_id_for_family("auto"), "sense-voice");
    }
}
