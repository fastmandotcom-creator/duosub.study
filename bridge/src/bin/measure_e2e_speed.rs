//! Standalone real-world runtime speed benchmark for DuoSub Live Caption.
//! Feeds real Vietnamese audio in real time (100ms frames every 100ms) into the
//! production pipeline (Whisper medium, EnergySegmenter with partials, Diarizer).
//! Measures:
//!   - Time-to-first-partial (TTP)
//!   - Partial update cadence
//!   - Final commit latency
//!   - Real-time factor (RTF)

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use std::sync::mpsc;
use std::time::{Duration, Instant};

use wisp_core::audio::{AudioFrame, AudioSource, AudioSourceInfo};
use wisp_core::transcript::{AudioSourceKind, SegmentStatus, TranscriptEvent};
use wisp_engine_sherpa::{SherpaLiveDiarizer, WhisperEngine};
use wisp_pipeline::{EnergySegmenter, EnergyVad, LiveStream, Session, Transcriber};

struct RealtimeWavSource {
    samples: Vec<f32>,
    pos: usize,
    sample_rate: u32,
    frame_len: usize,
    interval: Duration,
    next_tick: Instant,

    timestamp: Duration,
}

impl RealtimeWavSource {
    fn from_wav_file(path: &Path, frame_ms: u64) -> Result<Self, String> {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;

        // Simple WAV 16kHz 16-bit mono parser (skip 44-byte header)
        if bytes.len() < 44 {
            return Err("WAV file too short".into());
        }
        let pcm_bytes = &bytes[44..];
        let mut samples = Vec::with_capacity(pcm_bytes.len() / 2);
        for chunk in pcm_bytes.chunks_exact(2) {
            let sample_i16 = i16::from_le_bytes([chunk[0], chunk[1]]);
            samples.push(sample_i16 as f32 / 32768.0);
        }

        let sample_rate = 16_000;
        let frame_len = (sample_rate as u64 * frame_ms / 1000) as usize;
        let interval = Duration::from_millis(frame_ms);

        Ok(Self {
            samples,
            pos: 0,
            sample_rate,
            frame_len,
            interval,
            next_tick: Instant::now(),
            timestamp: Duration::ZERO,
        })
    }
}

impl AudioSource for RealtimeWavSource {
    fn info(&self) -> AudioSourceInfo {
        AudioSourceInfo {
            kind: AudioSourceKind::System,
            name: "e2e-realtime-wav".into(),
        }
    }

    fn next_frame(&mut self) -> wisp_core::error::Result<Option<AudioFrame>> {
        if self.pos >= self.samples.len() {
            // Stream finished: wait 1 second of trailing silence to let hangover flush
            if self.pos < self.samples.len() + (16_000 * 2) {
                let silence_frame = AudioFrame::new(
                    vec![0.0; self.frame_len],
                    self.sample_rate,
                    1,
                    self.timestamp,
                );
                self.pos += self.frame_len;
                self.timestamp += self.interval;
                std::thread::sleep(self.interval);
                return Ok(Some(silence_frame));
            }
            return Ok(None);
        }

        // Real-time pacing: sleep until next 100ms tick
        let now = Instant::now();
        if now < self.next_tick {
            std::thread::sleep(self.next_tick - now);
        }
        self.next_tick += self.interval;

        let end = (self.pos + self.frame_len).min(self.samples.len());
        let mut chunk = self.samples[self.pos..end].to_vec();
        if chunk.len() < self.frame_len {
            chunk.resize(self.frame_len, 0.0);
        }

        let frame = AudioFrame::new(chunk, self.sample_rate, 1, self.timestamp);
        self.pos += self.frame_len;
        self.timestamp += self.interval;

        Ok(Some(frame))
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let wav_path = PathBuf::from("/tmp/e2e_vi_speech.wav");
    if !wav_path.exists() {
        eprintln!("Error: /tmp/e2e_vi_speech.wav not found");
        std::process::exit(1);
    }

    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/admin".into());
    let models_dir = PathBuf::from(&home).join(".duosub/models");
    let whisper_dir = models_dir.join("whisper-medium");
    let encoder = whisper_dir.join("medium-encoder.int8.onnx");
    let decoder = whisper_dir.join("medium-decoder.int8.onnx");
    let tokens = whisper_dir.join("medium-tokens.txt");

    println!("============================================================");
    println!("     DUOSUB RUNTIME LIVE CAPTION E2E SPEED BENCHMARK        ");
    println!("============================================================");
    println!("Model:     Whisper medium (Finals only)");
    println!("Audio:     {:?}", wav_path);
    println!("Pacing:    Real-time 1.0x (100ms frames every 100ms)");
    println!("Hangover:  700ms silence gate");
    println!("VAD floor: 0.004 RMS energy");
    println!("------------------------------------------------------------");

    print!("Loading Whisper medium model... ");
    let t_load = Instant::now();

    let engine = WhisperEngine::new(&encoder, &decoder, &tokens, "vi")?;

    println!("done in {:.2}s", t_load.elapsed().as_secs_f64());

    let mut transcriber = Transcriber::new(Box::new(engine), AudioSourceKind::System);
    let diarize_dir = models_dir.join("diarization/embedding.onnx");
    if diarize_dir.exists() {
        if let Ok(diarizer) = SherpaLiveDiarizer::new(&diarize_dir) {
            transcriber = transcriber.with_diarizer(Box::new(diarizer));
            println!("Diarizer:  Loaded (embedding.onnx)");
        }
    }

    let source = Box::new(RealtimeWavSource::from_wav_file(&wav_path, 100)?);
    let segmenter = Box::new(EnergySegmenter::new(
        Box::new(EnergyVad::new(0.004)),
        Duration::from_millis(700),
    ));

    let stream = LiveStream {
        segmenter,
        source,
        denoiser: None,
        kind: AudioSourceKind::System,
    };

    let (tx, rx) = mpsc::channel();
    let sink: wisp_pipeline::EventSink = Box::new(move |event| {
        let _ = tx.send((Instant::now(), event));
    });

    println!("------------------------------------------------------------");
    println!("Starting real-time playback simulation (10.5s audio)...");
    let t_start = Instant::now();

    let session = Session::spawn_live_multi(vec![stream], transcriber, sink);

    let mut first_partial_latency: Option<Duration> = None;
    let mut partial_count = 0;
    let mut final_count = 0;

    println!(
        "{:<10} {:<10} {:<10} {:<12} {}",
        "WALL TIME", "AUDIO POS", "EVENT", "LATENCY", "TRANSCRIPT"
    );
    println!("------------------------------------------------------------");

    while let Ok((t_event, event)) = rx.recv_timeout(Duration::from_secs(18)) {
        let wall = t_event.duration_since(t_start);
        match event {
            TranscriptEvent::Segment(seg) => {
                let is_final = seg.status == SegmentStatus::Final;
                let kind = if is_final { "FINAL" } else { "PARTIAL" };
                let audio_pos = seg.start + seg.duration();
                let latency = if wall >= audio_pos {
                    wall - audio_pos
                } else {
                    Duration::ZERO
                };

                if !is_final && first_partial_latency.is_none() {
                    first_partial_latency = Some(wall);
                }
                if is_final {
                    final_count += 1;
                } else {
                    partial_count += 1;
                }

                let speaker = seg
                    .speaker
                    .map(|s| format!("Spk{}", s.0))
                    .unwrap_or_else(|| "Them".into());
                println!(
                    "{:>6.2}s     {:>6.2}s     {:<7}  +{:>4}ms      [{}] {}",
                    wall.as_secs_f64(),
                    audio_pos.as_secs_f64(),
                    kind,
                    latency.as_millis(),
                    speaker,
                    seg.text
                );
            }
            _ => {}
        }
    }

    let _ = session.stop();

    let total_elapsed = t_start.elapsed();
    println!("============================================================");
    println!("                 BENCHMARK SUMMARY RESULTS                  ");
    println!("============================================================");
    if let Some(ttp) = first_partial_latency {
        println!(
            "Time-to-First-Partial (TTP): {:.2}s  (words appeared while speaking)",
            ttp.as_secs_f64()
        );
    } else {
        println!("Time-to-First-Partial (TTP): NONE (partials failed to emit)");
    }
    println!("Partials Emitted:            {}", partial_count);
    println!("Final Segments Committed:    {}", final_count);
    println!(
        "Total Wall-Clock Time:       {:.2}s (audio was 10.49s)",
        total_elapsed.as_secs_f64()
    );
    let rtf = total_elapsed.as_secs_f64() / 10.49;
    println!(
        "Real-Time Factor (RTF):      {:.2}x ({})",
        rtf,
        if rtf <= 1.25 {
            "REAL-TIME / FAST"
        } else {
            "LAGGING"
        }
    );
    println!("============================================================");

    Ok(())
}
