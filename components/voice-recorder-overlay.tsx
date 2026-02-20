"use client";

/**
 * Generic voice recorder overlay: CenterOverlay + MediaRecorder + SpeechRecognition.
 * Optional real-time transcript (finals + last interim after stop), upload, then onResult.
 */

declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition;
    webkitSpeechRecognition: typeof SpeechRecognition;
  }
}

import { LoaderIcon, SquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CenterOverlay } from "./center-overlay";
import { Button } from "./ui/button";

export type VoiceRecordResult = {
  audioUrl: string;
  transcript: string;
  durationMs: number;
  mimeType: string;
  sizeBytes: number;
};

const DEFAULT_RECORDING_TITLE = "Recording...";
const DEFAULT_UPLOADING_TEXT = "Uploading...";
const TRANSCRIPT_DELAY_MS = 1000;

type VoiceRecorderOverlayProps = {
  onResult: (data: VoiceRecordResult) => void;
  /** When this number increases, start recording. */
  startTrigger?: number;
  uploadUrl?: string;
  /** Default UI: title above hints */
  recordingTitle?: string;
  recordingHints?: string[];
  stopLabel?: string;
  uploadingText?: string;
  /** Full custom overlay content. */
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
  children,
}: VoiceRecorderOverlayProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef(0);
  const lastTriggerRef = useRef(0);
  const transcriptRef = useRef("");
  const lastInterimRef = useRef("");

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      startTimeRef.current = Date.now();
      transcriptRef.current = "";
      lastInterimRef.current = "";

      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const durationMs = Date.now() - startTimeRef.current;
        const blob = new Blob(chunksRef.current, { type: mimeType });
        stream.getTracks().forEach((t) => t.stop());

        setTimeout(async () => {
          const finals = transcriptRef.current.trim();
          const lastInterim = lastInterimRef.current.trim();
          const finalTranscript =
            finals + (finals && lastInterim ? " " : "") + lastInterim;
          transcriptRef.current = "";
          lastInterimRef.current = "";

          setIsUploading(true);
          try {
            const formData = new FormData();
            const ext = mimeType === "audio/webm" ? "webm" : "mp4";
            formData.append(
              "file",
              new File([blob], `voice-${Date.now()}.${ext}`, {
                type: mimeType,
              }),
            );

            const response = await fetch(uploadUrl, {
              method: "POST",
              body: formData,
            });

            if (!response.ok) {
              const { error } = await response.json();
              throw new Error(error ?? "Upload failed");
            }

            const data = await response.json();

            onResult({
              audioUrl: data.url,
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
        }, TRANSCRIPT_DELAY_MS);
      };

      recorder.start(1000);

      const SpeechRecognitionCtor =
        window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognitionCtor) {
        const recognition = new SpeechRecognitionCtor();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "en-US";
        recognitionRef.current = recognition;

        recognition.onresult = (event: SpeechRecognitionEvent) => {
          const results = event.results;
          for (let i = event.resultIndex; i < results.length; i += 1) {
            const result = results[i];
            if (!result[0]) continue;
            const segment = result[0].transcript.trim();
            if (!segment) continue;
            if (result.isFinal) {
              transcriptRef.current =
                transcriptRef.current +
                (transcriptRef.current ? " " : "") +
                segment;
              lastInterimRef.current = "";
            } else {
              lastInterimRef.current = segment;
            }
          }
        };

        recognition.onerror = () => {};

        recognition.start();
      }

      setIsRecording(true);
    } catch (err) {
      console.error("Failed to start recording:", err);
      toast.error("Microphone access denied or unavailable");
    }
  }, [onResult, uploadUrl]);

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
