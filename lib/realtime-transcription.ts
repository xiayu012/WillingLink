/**
 * OpenAI Realtime API transcription: types and constants for WebSocket events
 * and PCM streaming (24 kHz mono, 16-bit little-endian).
 */

/** No model param for transcription sessions (GA). */
export const REALTIME_WS_URL = "wss://api.openai.com/v1/realtime";

export const TARGET_SAMPLE_RATE = 24_000;
export const PCM_BYTES_PER_SAMPLE = 2;

/** BCP 47 (e.g. en-US) -> ISO 639-1 (e.g. en). */
export function bcp47ToLanguage(bcp47: string): string {
  const first = bcp47.split("-")[0];
  return first?.toLowerCase() ?? "en";
}

/** Server -> client event types we care about. */
export type RealtimeServerEvent =
  | { type: "session.created"; session: unknown }
  | { type: "error"; error: { message?: string; code?: string } }
  | {
      type: "conversation.item.input_audio_transcription.delta";
      delta?: string;
    }
  | {
      type: "conversation.item.input_audio_transcription.completed";
      transcript?: string;
    }
  | { type: string };

/** Client -> server: append PCM base64 chunk. */
export function buildInputAudioBufferAppend(base64Audio: string): string {
  return JSON.stringify({
    type: "input_audio_buffer.append",
    audio: base64Audio,
  });
}

/** Client -> server: commit buffer (e.g. when user stops talking). */
export function buildInputAudioBufferCommit(): string {
  return JSON.stringify({ type: "input_audio_buffer.commit" });
}
