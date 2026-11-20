#!/usr/bin/env node
/**
 * Dev-only fake DuoSub bridge. Serves the REAL wire contract on 127.0.0.1:4499 with synthetic
 * captions, so the desktop UI can be exercised without a model download or a microphone grant.
 *
 *   node scripts/mock-bridge.mjs
 *   npm run dev        # in another shell
 */
import http from 'node:http';

const PORT = Number(process.env.DUOSUB_PORT ?? 4499);
const SAMPLE = [
  'Xin chào, đây là bản thử nghiệm.',
  'Âm thanh được nhận dạng ngay trên máy của bạn.',
  'Chỉ câu văn bản đã nhận dạng mới được gửi đi để dịch.',
  'Phụ đề xuất hiện ở đây theo thời gian thực.',
  'Bạn có thể bật overlay bằng phím Alt Shift O.',
];

let seq = 0;
let segmentId = 0;
let sessionActive = false;
const clients = new Set();
let startedAt = 0;

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, accept',
  });
  res.end(JSON.stringify(body));
};

const health = () => ({
  ok: true,
  version: 'mock-1.0',
  family: 'apple-speech',
  model_id: 'apple-speech',
  model_ready: true,
  sources: ['system'],
  supported_languages: ['auto', 'en', 'vi', 'ja', 'zh', 'ko', 'yue'],
  system_audio: 'granted',
  apple_speech_available: true,
  platform: 'macos',
  arch: 'aarch64',
  capture_backend: 'ScreenCaptureKit',
  system_audio_supported: true,
  session: {
    active: sessionActive,
    session_id: sessionActive ? 'mock-session' : null,
    language: 'vi',
    segment_count: segmentId,
    warnings: [],
  },
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/health') return json(res, 200, health());

  if (url.pathname === '/sessions/start' && req.method === 'POST') {
    sessionActive = true;
    startedAt = Date.now();
    segmentId = 0;
    json(res, 201, { started: true, sessionId: 'mock-session', warnings: [] });
    return;
  }
  if (url.pathname === '/sessions/stop' && req.method === 'POST') {
    sessionActive = false;
    return json(res, 200, { stopped: true });
  }
  if (url.pathname === '/sessions/claim' || url.pathname === '/sessions/heartbeat') {
    return json(res, 200, { claimed: true, alive: true });
  }
  if (url.pathname === '/sessions/release') return json(res, 200, { released: true });
  if (url.pathname === '/models/select') {
    const family = 'apple-speech';
    return json(res, 200, { selected: true, family, model_id: family, supported_languages: health().supported_languages });
  }
  if (url.pathname.startsWith('/permissions/')) return json(res, 200, { opened: true, granted: true });

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  json(res, 404, { error: 'not found' });
});

function broadcast(event) {
  const frame = `id: ${event.seq}\nevent: segment\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(frame);
}

const timer = setInterval(() => {
  if (!sessionActive || clients.size === 0) return;
  const index = segmentId % SAMPLE.length;
  const text = SAMPLE[index];
  seq += 1;
  segmentId += 1;
  const id = segmentId;
  // First a partial, then the committed final with the same segment_id.
  broadcast({
    seq,
    ts: Date.now(),
    kind: 'segment',
    session_id: 'mock-session',
    segment_id: id,
    text: text.slice(0, Math.max(3, Math.floor(text.length * 0.6))),
    final: false,
    source: index % 2 === 0 ? 'system' : 'microphone',
    language: 'vi',
    t0_ms: Date.now() - startedAt - 1200,
    t1_ms: Date.now() - startedAt,
  });
  setTimeout(() => {
    if (!sessionActive) return;
    seq += 1;
    broadcast({
      seq,
      ts: Date.now(),
      kind: 'segment',
      session_id: 'mock-session',
      segment_id: id,
      text,
      final: true,
      source: index % 2 === 0 ? 'system' : 'microphone',
      language: 'vi',
      t0_ms: Date.now() - startedAt - 1200,
      t1_ms: Date.now() - startedAt,
    });
  }, 420);
}, 2600);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock DuoSub bridge listening on http://127.0.0.1:${PORT}`);
});

process.on('SIGINT', () => {
  clearInterval(timer);
  server.close(() => process.exit(0));
});
