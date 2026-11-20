//! Linux system/meeting-audio capture.
//!
//! PulseAudio and PipeWire (through its PulseAudio compatibility server) expose every playback
//! sink as a *monitor* input device. Capturing that device is the Linux equivalent of WASAPI
//! loopback on Windows and ScreenCaptureKit on macOS: it records what the meeting app plays
//! without a virtual cable or a microphone grant.
//!
//! The pure name-matching helper lives at the crate root so it is unit-testable on every host;
//! the cpal-backed source is compiled only on Linux, like `wisp-loopback` is only on Windows.

/// Recognises PulseAudio/PipeWire monitor and virtual loopback device names.
///
/// Examples that must match:
/// - `alsa_output.pci-0000_00_1f.3.analog-stereo.monitor`
/// - `Monitor of Built-in Audio Analog Stereo`
/// - `@DEFAULT_SINK@.monitor`
pub fn is_monitor_device_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("monitor") || lower.contains("loopback") || lower.contains("@default_sink@")
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::PulseLoopbackSource;

#[cfg(test)]
mod tests {
    use super::is_monitor_device_name;

    #[test]
    fn matches_pulseaudio_and_pipewire_monitor_names() {
        assert!(is_monitor_device_name(
            "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor"
        ));
        assert!(is_monitor_device_name(
            "Monitor of Built-in Audio Analog Stereo"
        ));
        assert!(is_monitor_device_name("@DEFAULT_SINK@.monitor"));
        assert!(is_monitor_device_name("Loopback of Zoom Audio"));
    }

    #[test]
    fn never_mistakes_a_physical_microphone_for_system_audio() {
        assert!(!is_monitor_device_name("Built-in Audio Analog Stereo"));
        assert!(!is_monitor_device_name("USB Microphone"));
        assert!(!is_monitor_device_name("default"));
        assert!(!is_monitor_device_name(""));
    }
}
