"use client";

/**
 * Post-shift voice recording: overlay-only UI (no bar in input).
 * Starts when startTrigger increments (e.g. after "Post shift" click).
 * Records via MediaRecorder + SpeechRecognition, uploads to Blob, returns result to parent.
 */

declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition;
    webkitSpeechRecognition: typeof SpeechRecognition;
  }
}

import { createPortal } from "react-dom";
import { LoaderIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

const RECORDING_HINT_LINES = [
  "Speak to the community. Try to include:",
  "What to do",
  "Start time",
  "Where",
  "Skills needed",
  "Who is being helped",
  "How long",
];

export type ShiftVoiceResult = {
  audioUrl: string;
  transcript: string;
  durationMs: number;
  mimeType: string;
  sizeBytes: number;
};

type ShiftVoiceRecorderProps = {
  onResult: (data: ShiftVoiceResult) => void;
  /** When this number increases, start recording (e.g. after Post shift click) */
  startTrigger?: number;
};

export function ShiftVoiceRecorder({
  onResult,
  startTrigger = 0,
}: ShiftVoiceRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const lastTriggerRef = useRef(0);
  const transcriptRef = useRef("");

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

      recorder.onstop = async () => {
        const durationMs = Date.now() - startTimeRef.current;
        const blob = new Blob(chunksRef.current, { type: mimeType });
        stream.getTracks().forEach((t) => t.stop());

        setIsUploading(true);
        try {
          const formData = new FormData();
          const ext = mimeType === "audio/webm" ? "webm" : "mp4";
          formData.append(
            "file",
            new File([blob], `shift-voice-${Date.now()}.${ext}`, {
              type: mimeType,
            }),
          );

          const response = await fetch("/api/files/upload", {
            method: "POST",
            body: formData,
          });

          if (!response.ok) {
            const { error } = await response.json();
            throw new Error(error ?? "Upload failed");
          }

          const data = await response.json();
          const finalTranscript = transcriptRef.current || "";

          onResult({
            audioUrl: data.url,
            transcript: finalTranscript,
            durationMs,
            mimeType,
            sizeBytes: blob.size,
          });
        } catch (err) {
          console.error("Failed to upload voice:", err);
          toast.error("Failed to upload voice recording");
        } finally {
          setIsUploading(false);
          transcriptRef.current = "";
        }
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
          let finalText = "";
          let interimText = "";
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i];
            if (result.isFinal) {
              finalText += result[0].transcript + " ";
            } else {
              interimText += result[0].transcript;
            }
          }
          transcriptRef.current = (
            transcriptRef.current +
            finalText +
            interimText
          ).trim();
        };

        recognition.onerror = () => {
          // Ignore aborted/no-speech; log others
        };

        recognition.start();
      }

      setIsRecording(true);
    } catch (err) {
      console.error("Failed to start recording:", err);
      toast.error("Microphone access denied or unavailable");
    }
  }, [onResult]);

  // Auto-start when parent increments startTrigger (e.g. after Post shift click)
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

  const showOverlay =
    typeof document !== "undefined" && (isRecording || isUploading);
  const overlayContent = showOverlay
    ? createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
            aria-hidden
          >
            <div
              className={cn(
                "pointer-events-auto max-w-md rounded-2xl px-8 py-6 text-center shadow-lg ring-1 ring-border/50",
                "bg-background/95 backdrop-blur-sm",
                "animate-in fade-in duration-200",
              )}
            >
              {isUploading ? (
                <div className="flex flex-col items-center gap-3 text-muted-foreground">
                  <LoaderIcon className="size-8 animate-spin" />
                  <p className="text-sm">Uploading voice...</p>
                </div>
              ) : (
                <>
                  <p className="text-foreground/90 text-lg font-medium leading-snug">
                    {RECORDING_HINT_LINES[0]}
                  </p>
                  <ul className="mt-4 space-y-1.5 text-muted-foreground text-sm">
                    {RECORDING_HINT_LINES.slice(1).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <Button
                    className="mt-6 w-full rounded-xl border-red-500 bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-950 dark:text-red-400 dark:hover:bg-red-900"
                    onClick={stopRecording}
                    type="button"
                    variant="outline"
                  >
                    <SquareIcon className="size-4 fill-current" />
                    <span>Stop Recording</span>
                  </Button>
                </>
              )}
            </div>
          </div>,
          document.body,
        )
      : null;

  return <>{overlayContent}</>;
}

