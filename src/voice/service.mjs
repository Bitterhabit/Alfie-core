/**
 * Local/Hybrid Voice Loop Service (Phase 4)
 *
 * Bridges Alfie Core to optional local self-hosted voice servers:
 *  - Whisper-compatible STT: ALFIE_WHISPER_URL (e.g. http://127.0.0.1:8000/v1/audio/transcriptions)
 *  - Piper / Kokoro-compatible TTS: ALFIE_TTS_URL (e.g. http://127.0.0.1:8880/v1/audio/speech)
 *
 * When local containers aren't configured, the frontend seamlessly uses the
 * browser's native Web Speech API (push-to-talk STT + interruptible SpeechSynthesis TTS).
 * Zero always-on hotword listening (explicit non-goal).
 */

const MAX_AUDIO_BASE64_LEN = 7 * 1024 * 1024; // ~5MB decoded
const MAX_TTS_TEXT_LEN = 1200;
const VOICE_TIMEOUT_MS = 15000;

function validHttpUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getVoiceStatus() {
  const whisperUrl = validHttpUrl(process.env.ALFIE_WHISPER_URL);
  const ttsUrl = validHttpUrl(process.env.ALFIE_TTS_URL);
  return {
    pushToTalkOnly: true,
    hotwordDisabled: true,
    stt: {
      localConfigured: Boolean(whisperUrl),
      engine: whisperUrl ? "local-whisper" : "browser-web-speech-fallback",
      model: process.env.ALFIE_WHISPER_MODEL || "whisper-1"
    },
    tts: {
      localConfigured: Boolean(ttsUrl),
      engine: ttsUrl ? "local-piper-kokoro" : "browser-speech-synthesis-fallback",
      voice: process.env.ALFIE_TTS_VOICE || "af_bella",
      interruptible: true
    }
  };
}

export async function transcribeAudio({ audioBase64, mimeType = "audio/webm", language = "en", fetchImpl = fetch } = {}) {
  const whisperUrl = validHttpUrl(process.env.ALFIE_WHISPER_URL);
  if (!whisperUrl) {
    throw Object.assign(new Error("Local Whisper STT is not configured (set ALFIE_WHISPER_URL). Browser speech recognition remains available."), {
      status: 503,
      code: "LOCAL_STT_UNCONFIGURED"
    });
  }
  const cleanB64 = String(audioBase64 || "").trim();
  if (!cleanB64 || cleanB64.length > MAX_AUDIO_BASE64_LEN) {
    throw Object.assign(new Error("Audio payload is missing or exceeds the 5MB limit."), { status: 400 });
  }
  const safeMime = /^audio\/[a-z0-9.+-]{1,32}$/i.test(String(mimeType || "")) ? String(mimeType) : "audio/webm";
  const buffer = Buffer.from(cleanB64, "base64");

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: safeMime }), "clip.webm");
  form.append("model", process.env.ALFIE_WHISPER_MODEL || "whisper-1");
  if (language) form.append("language", String(language).slice(0, 12));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
  try {
    const headers = {};
    if (process.env.ALFIE_WHISPER_TOKEN) {
      headers.authorization = `Bearer ${process.env.ALFIE_WHISPER_TOKEN}`;
    }
    const res = await fetchImpl(whisperUrl, {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal
    });
    if (!res.ok) {
      throw Object.assign(new Error(`Local Whisper STT failed (${res.status}).`), { status: 502 });
    }
    const data = await res.json();
    return {
      text: String(data?.text || "").trim(),
      engine: "local-whisper"
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function synthesizeSpeech({ text, voice = "", speed = 1.0, fetchImpl = fetch } = {}) {
  const ttsUrl = validHttpUrl(process.env.ALFIE_TTS_URL);
  if (!ttsUrl) {
    throw Object.assign(new Error("Local Piper/Kokoro TTS is not configured (set ALFIE_TTS_URL). Browser SpeechSynthesis remains available."), {
      status: 503,
      code: "LOCAL_TTS_UNCONFIGURED"
    });
  }
  const cleanText = String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_TTS_TEXT_LEN);
  if (!cleanText) {
    throw Object.assign(new Error("Text is required for speech synthesis."), { status: 400 });
  }
  const safeSpeed = Math.max(0.6, Math.min(1.6, Number(speed) || 1.0));
  const safeVoice = String(voice || process.env.ALFIE_TTS_VOICE || "af_bella").trim().slice(0, 64);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
  try {
    const headers = { "content-type": "application/json" };
    if (process.env.ALFIE_TTS_TOKEN) {
      headers.authorization = `Bearer ${process.env.ALFIE_TTS_TOKEN}`;
    }
    const res = await fetchImpl(ttsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: process.env.ALFIE_TTS_MODEL || "kokoro",
        input: cleanText,
        voice: safeVoice,
        speed: safeSpeed,
        response_format: "mp3"
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      throw Object.assign(new Error(`Local TTS service failed (${res.status}).`), { status: 502 });
    }
    const audioBuffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "audio/mpeg";
    return {
      audioBase64: audioBuffer.toString("base64"),
      contentType,
      engine: "local-piper-kokoro"
    };
  } finally {
    clearTimeout(timer);
  }
}
