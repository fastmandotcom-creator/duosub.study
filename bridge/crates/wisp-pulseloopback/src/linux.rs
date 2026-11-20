//! cpal-based capture of a PulseAudio/PipeWire monitor source. The cpal `Stream` is `!Send`, so it
//! lives on its own thread and feeds frames to the pipeline through a bounded channel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use wisp_core::audio::{AudioFrame, AudioSource, AudioSourceInfo};
use wisp_core::channel::{frame_channel, FrameReceiver, FrameSender};
use wisp_core::error::{Result, WispError};
use wisp_core::transcript::AudioSourceKind;

use crate::is_monitor_device_name;

const FRAME_CHANNEL_CAPACITY: usize = 1024;

#[derive(Clone, Copy)]
struct Framing {
    sample_rate: u32,
    channels: u16,
    start: Instant,
}

/// An [`AudioSource`] capturing the default sink's monitor (i.e. system/meeting audio).
pub struct PulseLoopbackSource {
    rx: FrameReceiver,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    info: AudioSourceInfo,
}

impl PulseLoopbackSource {
    /// Finds a monitor input device and starts capturing. Fails loudly when none exists so the
    /// bridge can degrade to microphone-only with an actionable warning instead of recording the
    /// microphone and labelling it "system audio".
    pub fn new() -> Result<Self> {
        let host = cpal::default_host();
        let device = host
            .input_devices()
            .map_err(|e| WispError::Audio(format!("enumerate input devices: {e}")))?
            .find(|d| d.name().is_ok_and(|name| is_monitor_device_name(&name)))
            .ok_or_else(|| {
                WispError::Audio(
                    "no PulseAudio/PipeWire monitor input found — enable the PulseAudio compatibility \
                     server on PipeWire (pipewire-pulse) and retry".to_owned(),
                )
            })?;
        Self::from_device(device)
    }

    fn from_device(device: cpal::Device) -> Result<Self> {
        let name = device.name().unwrap_or_else(|_| "monitor".to_owned());
        let supported = device
            .default_input_config()
            .map_err(|e| WispError::Audio(format!("default input config for '{name}': {e}")))?;

        let (tx, rx) = frame_channel(FRAME_CHANNEL_CAPACITY);
        let (ready_tx, ready_rx) = mpsc::channel::<std::result::Result<(), String>>();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop);
        let handle =
            thread::spawn(move || capture_loop(device, supported, tx, stop_for_thread, ready_tx));

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                rx,
                stop,
                handle: Some(handle),
                info: AudioSourceInfo {
                    kind: AudioSourceKind::System,
                    name: format!("System audio ({name})"),
                },
            }),
            Ok(Err(e)) => Err(WispError::Audio(e)),
            Err(_) => Err(WispError::Audio(
                "monitor capture thread exited before signalling readiness".to_owned(),
            )),
        }
    }
}

impl AudioSource for PulseLoopbackSource {
    fn info(&self) -> AudioSourceInfo {
        self.info.clone()
    }

    fn next_frame(&mut self) -> Result<Option<AudioFrame>> {
        Ok(self.rx.recv())
    }
}

impl Drop for PulseLoopbackSource {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            handle.thread().unpark();
            let _ = handle.join();
        }
    }
}

fn capture_loop(
    device: cpal::Device,
    supported: cpal::SupportedStreamConfig,
    tx: FrameSender,
    stop: Arc<AtomicBool>,
    ready: Sender<std::result::Result<(), String>>,
) {
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let framing = Framing {
        sample_rate: config.sample_rate.0,
        channels: config.channels,
        start: Instant::now(),
    };

    let stream = match build_stream(&device, &config, format, tx, framing) {
        Ok(stream) => stream,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = ready.send(Err(format!("play monitor stream: {e}")));
        return;
    }
    let _ = ready.send(Ok(()));

    while !stop.load(Ordering::Relaxed) {
        thread::park_timeout(Duration::from_millis(100));
    }
    drop(stream);
}

fn build_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    format: cpal::SampleFormat,
    tx: FrameSender,
    framing: Framing,
) -> std::result::Result<cpal::Stream, String> {
    let on_error = {
        let tx = tx.clone();
        move |error: cpal::StreamError| {
            eprintln!("wisp: monitor stream error, closing system source: {error}");
            tx.close();
        }
    };
    match format {
        cpal::SampleFormat::F32 => to_build_err(device.build_input_stream(
            config,
            move |data: &[f32], _| send_samples(&tx, data.to_vec(), framing),
            on_error,
            None,
        )),
        cpal::SampleFormat::I16 => to_build_err(device.build_input_stream(
            config,
            move |data: &[i16], _| {
                send_samples(
                    &tx,
                    data.iter().map(|s| f32::from(*s) / 32_768.0).collect(),
                    framing,
                );
            },
            on_error,
            None,
        )),
        cpal::SampleFormat::U16 => to_build_err(device.build_input_stream(
            config,
            move |data: &[u16], _| {
                send_samples(
                    &tx,
                    data.iter()
                        .map(|s| (f32::from(*s) - 32_768.0) / 32_768.0)
                        .collect(),
                    framing,
                );
            },
            on_error,
            None,
        )),
        other => Err(format!("unsupported monitor sample format: {other:?}")),
    }
}

fn to_build_err(
    result: std::result::Result<cpal::Stream, cpal::BuildStreamError>,
) -> std::result::Result<cpal::Stream, String> {
    result.map_err(|e| format!("build monitor input stream: {e}"))
}

fn send_samples(tx: &FrameSender, samples: Vec<f32>, framing: Framing) {
    tx.send(AudioFrame::new(
        samples,
        framing.sample_rate,
        framing.channels,
        framing.start.elapsed(),
    ));
}
