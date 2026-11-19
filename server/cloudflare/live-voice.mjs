import { fail } from '../core.mjs';

export const LIVE_VOICE_PROTOCOL = 'muse-relay-voice';
const MAX_PCM_BYTES = 30 * 16000 * 2;
const MAX_FRAME_BYTES = 64 * 1024;

export async function openLiveVoice(fetchImpl, apiKey) {
  let response;
  try {
    response = await fetchImpl('https://stt-rt.soniox.com/transcribe-websocket', {
      headers: { upgrade: 'websocket', authorization: `Bearer ${apiKey}` },
      redirect: 'manual', signal: AbortSignal.timeout(8000),
    });
  } catch { fail(502, 'soniox_upstream_unavailable'); }
  if (response.status !== 101 || !response.webSocket) fail(502, 'soniox_upgrade_failed');
  const [client, phone] = Object.values(new WebSocketPair());
  linkLiveVoice(phone, response.webSocket);
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': LIVE_VOICE_PROTOCOL } });
}

export function linkLiveVoice(phone, soniox) {
  let configured = false, finished = false, closed = false, bytes = 0;
  const sessionTimer = setTimeout(() => close(1011), 60_000);
  const configTimer = setTimeout(() => close(1008), 5000);
  function close(code = 1000) {
    if (closed) return;
    closed = true;
    clearTimeout(sessionTimer);
    clearTimeout(configTimer);
    for (const socket of [phone, soniox]) {
      try { socket.close(code); } catch { /* Already closed. */ }
    }
  }

  phone.binaryType = 'arraybuffer';
  phone.addEventListener('message', ({ data }) => {
    if (closed) return;
    try {
      if (!configured) {
        if (typeof data !== 'string' || data.length > 512) return close(1008);
        let hints;
        try { hints = JSON.parse(data)?.language_hints; } catch { return close(1008); }
        if (!Array.isArray(hints) || hints.length !== 1 || typeof hints[0] !== 'string' || !/^[a-z]{2}$/.test(hints[0])) return close(1008);
        soniox.send(JSON.stringify({ model: 'stt-rt-v6', audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1,
          language_hints: hints, enable_endpoint_detection: true }));
        configured = true;
        clearTimeout(configTimer);
      } else if (data === '' && !finished) {
        finished = true;
        soniox.send('');
      } else if (!finished && data instanceof ArrayBuffer && data.byteLength > 0 && data.byteLength % 2 === 0 && data.byteLength <= MAX_FRAME_BYTES) {
        bytes += data.byteLength;
        if (bytes > MAX_PCM_BYTES) return close(1009);
        soniox.send(data);
      } else close(1008);
    } catch { close(1011); }
  });
  soniox.addEventListener('message', ({ data }) => {
    if (closed) return;
    try {
      const result = JSON.parse(data);
      if (result.error_code) {
        phone.send(JSON.stringify({ error_code: Number(result.error_code) || 502 }));
        close(1011);
        return;
      }
      const tokens = Array.isArray(result.tokens) ? result.tokens.map(({ text, is_final }) => ({ text, is_final })) : [];
      phone.send(JSON.stringify({ tokens, finished: result.finished === true }));
      if (result.finished === true) close();
    } catch { close(1011); }
  });
  for (const socket of [phone, soniox]) {
    socket.addEventListener('close', () => close());
    socket.addEventListener('error', () => close(1011));
    socket.accept();
  }
}
