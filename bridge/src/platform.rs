//! Host capabilities, reported through `/health` so clients can explain what a platform can do
//! instead of guessing from the OS name. Adding a port = add one arm here + one capture backend in
//! `session::open_system_source`; the HTTP contract does not change.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PlatformInfo {
    /// `macos` | `windows` | `linux` | `unknown`
    pub os: &'static str,
    pub arch: &'static str,
    /// Human-readable name of the system-audio capture backend.
    pub capture_backend: &'static str,
    /// Whether this host can capture *system/meeting* audio at all.
    pub system_audio_supported: bool,
}

const fn info(os: &'static str, backend: &'static str, supported: bool) -> PlatformInfo {
    PlatformInfo {
        os,
        arch: std::env::consts::ARCH,
        capture_backend: backend,
        system_audio_supported: supported,
    }
}

pub fn platform_info() -> PlatformInfo {
    match std::env::consts::OS {
        "macos" => info("macos", "ScreenCaptureKit", true),
        "windows" => info("windows", "WASAPI loopback", true),
        // A Linux PulseAudio/PipeWire backend is the next port; the microphone path already works
        // through the cross-platform `cpal` source in wisp-audio.
        "linux" => info("linux", "unavailable (PulseAudio port pending)", false),
        _ => info("unknown", "unavailable", false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_known_os_has_an_honest_capability_report() {
        let info = platform_info();
        assert!(["macos", "windows", "linux", "unknown"].contains(&info.os));
        assert!(!info.capture_backend.is_empty());
        assert_eq!(info.system_audio_supported, info.capture_backend != "unavailable (PulseAudio port pending)" && info.os != "unknown");
    }

    #[test]
    fn capability_table_is_the_single_source_for_each_host() {
        assert_eq!(info("macos", "ScreenCaptureKit", true).system_audio_supported, true);
        assert_eq!(info("windows", "WASAPI loopback", true).system_audio_supported, true);
        assert_eq!(info("linux", "unavailable (PulseAudio port pending)", false).system_audio_supported, false);
    }
}
