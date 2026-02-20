"use client";

/**
 * Generic voice recorder overlay: CenterOverlay + MediaRecorder + OpenAI Realtime API.
 * Transcription via Realtime WebSocket (PCM 24kHz), then upload blob and onResult.
 */

import { LoaderIcon, SquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CenterOverlay } from "./center-overlay";
import { Button } from "./ui/button";
import {
  buildInputAudioBufferAppend,
  buildInputAudioBufferCommit,
  type RealtimeServerEvent,
  REALTIME_WS_URL,
  TARGET_SAMPLE_RATE,
} from "@/lib/realtime-transcription";

export type VoiceRecordResult = {
  audioUrl: string;
  transcript: string;
  durationMs: number;
  mimeType: string;
  sizeBytes: number;
};

const DEFAULT_RECORDING_TITLE = "Recording...";
const DEFAULT_UPLOADING_TEXT = "Uploading...";
const SESSION_API = "/api/realtime/session";
/** Max recording duration before auto-stop (5 minutes). */
const MAX_RECORDING_DURATION_MS = 5 * 60 * 1000;
/** Max wait from recording start (safety net; must be > MAX_RECORDING_DURATION_MS + transcript time). */
const TRANSCRIPT_SAFETY_MS = 600_000;
/** Wait for transcript after sending commit (stop); long audio needs more time. */
const TRANSCRIPT_WAIT_AFTER_COMMIT_MS = 20_000;
const COMMIT_DELAY_AFTER_STOP_MS = 400;

/** Float32 [-1,1] at sourceRate -> Int16 PCM at TARGET_SAMPLE_RATE, then base64. */
function resampleAndEncodePcmBase64(
  float32: Float32Array,
  sourceRate: number,
): string {
  const outLength = Math.floor(
    (float32.length * TARGET_SAMPLE_RATE) / sourceRate,
  );
  const pcm = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const srcIndex = (i * sourceRate) / TARGET_SAMPLE_RATE;
    const idx0 = Math.floor(srcIndex);
    const idx1 = Math.min(idx0 + 1, float32.length - 1);
    const frac = srcIndex - idx0;
    const sample =
      (idx0 === idx1 ? float32[idx0] : float32[idx0] * (1 - frac) + float32[idx1] * frac);
    const clamped = Math.max(-1, Math.min(1, sample));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const byteLength = pcm.byteLength;
  const binary = new Uint8Array(pcm.buffer, 0, byteLength);
  let binaryString = "";
  const chunkSize = 2048;
  for (let i = 0; i < binary.length; i += chunkSize) {
    const chunk = binary.subarray(i, Math.min(i + chunkSize, binary.length));
    for (let j = 0; j < chunk.length; j += 1) {
      binaryString += String.fromCharCode(chunk[j]);
    }
  }
  return btoa(binaryString);
}

type VoiceRecorderOverlayProps = {
  onResult: (data: VoiceRecordResult) => void;
  /** When this number increases, start recording. */
  startTrigger?: number;
  uploadUrl?: string;
  recordingTitle?: string;
  recordingHints?: string[];
  stopLabel?: string;
  uploadingText?: string;
  /** BCP 47 for transcription language (e.g. "en-US", "zh-CN"). */
  recognitionLang?: string;
  children?: (props: {
    phase: "recording" | "uploading";
    stopRecording: () => void;
  }) => ReactNode;
};

export function VoiceRecorderOverlay({
  onResult,
  startTrigger = 0,
  uploadUrl = "/api/files/upload",
  recordingTitle = DEFAULT_RECORDING_TITLE,
  recordingHints = [],
  stopLabel = "Stop Recording",
  uploadingText = DEFAULT_UPLOADING_TEXT,
  recognitionLang = "en-US",
  children,
}: VoiceRecorderOverlayProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef(0);
  const lastTriggerRef = useRef(0);
  const transcriptPartsRef = useRef<string[]>([]);
  const resolveTranscriptRef = useRef<((text: string) => void) | null>(null);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopRecording = useCallback(() => {
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    audioContextRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioContextRef.current = null;
    setIsRecording(false);
    // Commit and WS cleanup happen in recorder.onstop after delay
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      startTimeRef.current = Date.now();
      transcriptPartsRef.current = [];

      const sessionRes = await fetch(SESSION_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: recognitionLang }),
      });
      if (!sessionRes.ok) {
        const err = await sessionRes.json().catch(() => ({}));
        throw new Error(
          (err as { error?: string }).error ?? "Failed to create Realtime session",
        );
      }
      const sessionData = (await sessionRes.json()) as {
        client_secret?: string;
      };
      const token = sessionData.client_secret;
      if (!token) {
        throw new Error("No client_secret from Realtime session");
      }

      const ws = new WebSocket(REALTIME_WS_URL, [
        "realtime",
        `openai-insecure-api-key.${token}`,
      ]);
      wsRef.current = ws;

      const transcriptPromise = new Promise<string>((resolve) => {
        resolveTranscriptRef.current = resolve;
      });
      let transcriptTimeoutId: ReturnType<typeof setTimeout>;
      const resolveWithCurrentParts = () => {
        if (resolveTranscriptRef.current) {
          const fromParts = transcriptPartsRef.current.join(" ").trim();
          resolveTranscriptRef.current(fromParts);
          resolveTranscriptRef.current = null;
        }
      };
      transcriptTimeoutId = setTimeout(resolveWithCurrentParts, TRANSCRIPT_SAFETY_MS);

      ws.onmessage = (event: MessageEvent<string>) => {
        try {
          const data = JSON.parse(event.data) as RealtimeServerEvent & {
            transcript?: string;
            delta?: string;
          };
          if (data.type === "error") {
            const msg = (data as { error?: { message?: string } }).error?.message;
            toast.error(msg ?? "Realtime API error");
            return;
          }
          const isDelta =
            data.type === "conversation.item.input_audio_transcription.delta";
          const isCompleted =
            data.type ===
            "conversation.item.input_audio_transcription.completed";
          if (isDelta && typeof data.delta === "string" && data.delta.length > 0) {
            transcriptPartsRef.current.push(data.delta);
          }
          if (isCompleted) {
            if (resolveTranscriptRef.current) {
              clearTimeout(transcriptTimeoutId);
              const finalText =
                typeof data.transcript === "string" && data.transcript.length > 0
                  ? data.transcript.trim()
                  : transcriptPartsRef.current.join(" ").trim();
              resolveTranscriptRef.current(finalText);
              resolveTranscriptRef.current = null;
            }
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = () => {
        toast.error("Realtime connection error");
      };

      ws.onclose = () => {
        if (resolveTranscriptRef.current) {
          const text = transcriptPartsRef.current.join(" ").trim();
          resolveTranscriptRef.current(text);
          resolveTranscriptRef.current = null;
        }
      };

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WebSocket failed"));
      });

      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const durationMs = Date.now() - startTimeRef.current;
        const blob = new Blob(chunksRef.current, { type: mimeType });
        stream.getTracks().forEach((t) => t.stop());

        await new Promise((r) => setTimeout(r, COMMIT_DELAY_AFTER_STOP_MS));
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(buildInputAudioBufferCommit());
        }
        clearTimeout(transcriptTimeoutId);
        transcriptTimeoutId = setTimeout(
          resolveWithCurrentParts,
          TRANSCRIPT_WAIT_AFTER_COMMIT_MS,
        );

        let finalTranscript = "";
        try {
          finalTranscript = await transcriptPromise;
        } catch {
          // use empty if promise rejected
        }
        wsRef.current = null;
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
        if (!finalTranscript) {
          toast.info(
            "Transcription didn’t come back in time. Sending as voice message—you can try again if it happens often.",
          );
        }

        setIsUploading(true);
        try {
          const formData = new FormData();
          const ext = mimeType === "audio/webm" ? "webm" : "mp4";
          formData.append(
            "file",
            new File([blob], `voice-${Date.now()}.${ext}`, { type: mimeType }),
          );
          const response = await fetch(uploadUrl, {
            method: "POST",
            body: formData,
          });
          if (!response.ok) {
            const json = await response.json().catch(() => ({}));
            throw new Error(
              (json as { error?: string }).error ?? "Upload failed",
            );
          }
          const data = (await response.json()) as { url?: string };
          const audioUrl = data.url;
          if (!audioUrl) {
            throw new Error("No url in upload response");
          }
          onResult({
            audioUrl,
            transcript: finalTranscript,
            durationMs,
            mimeType,
            sizeBytes: blob.size,
          });
        } catch (err) {
          console.error("Voice upload failed:", err);
          toast.error("Failed to upload voice recording");
        } finally {
          setIsUploading(false);
        }
      };

      recorder.start(1000);

      autoStopTimerRef.current = setTimeout(() => {
        stopRecording();
      }, MAX_RECORDING_DURATION_MS);

      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const bufferSize = 4096;
      const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
      source.connect(processor);
      processor.connect(ctx.destination);
      const sampleRate = ctx.sampleRate;

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        const wsSocket = wsRef.current;
        if (wsSocket?.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const base64 = resampleAndEncodePcmBase64(input, sampleRate);
        if (base64.length > 0) {
          wsSocket.send(buildInputAudioBufferAppend(base64));
        }
      };

      setIsRecording(true);
    } catch (err) {
      console.error("Failed to start recording:", err);
      toast.error(
        err instanceof Error ? err.message : "Microphone access denied or unavailable",
      );
    }
  }, [onResult, uploadUrl, recognitionLang, stopRecording]);

  const startRecordingRef = useRef(startRecording);
  startRecordingRef.current = startRecording;
  useEffect(() => {
    if (startTrigger <= 0 || startTrigger === lastTriggerRef.current) return;
    const t = setTimeout(() => {
      startRecordingRef.current();
      lastTriggerRef.current = startTrigger;
    }, 200);
    return () => clearTimeout(t);
  }, [startTrigger]);

  const phase = isUploading ? "uploading" : "recording";
  const show = isRecording || isUploading;

  return (
    <CenterOverlay show={show}>
      {children ? (
        children({ phase, stopRecording })
      ) : (
        <>
          {phase === "uploading" ? (
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <LoaderIcon className="size-8 animate-spin" />
              <p className="text-sm">{uploadingText}</p>
            </div>
          ) : (
            <>
              <p className="text-foreground/90 text-lg font-medium leading-snug">
                {recordingTitle}
              </p>
              {recordingHints.length > 0 && (
                <ul className="mt-4 space-y-1.5 text-muted-foreground text-sm">
                  {recordingHints.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              <Button
                className="mt-6 w-full rounded-xl border-red-500 bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-950 dark:text-red-400 dark:hover:bg-red-900"
                onClick={stopRecording}
                type="button"
                variant="outline"
              >
                <SquareIcon className="size-4 fill-current" />
                <span>{stopLabel}</span>
              </Button>
            </>
          )}
        </>
      )}
    </CenterOverlay>
  );
}
