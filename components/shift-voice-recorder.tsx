"use client";

/**
 * Post-shift voice recording: uses generic VoiceRecorderOverlay with shift-specific hints.
 */

import {
  type VoiceRecordResult,
  VoiceRecorderOverlay,
} from "./voice-recorder-overlay";

const RECORDING_HINT_LINES = [
  "Speak to the community. Try to include:",
  "What to do",
  "Start time",
  "Where",
  "Skills needed",
  "Who is being helped",
  "How long",
];

export type ShiftVoiceResult = VoiceRecordResult;

type ShiftVoiceRecorderProps = {
  onResult: (data: ShiftVoiceResult) => void;
  startTrigger?: number;
};

export function ShiftVoiceRecorder({
  onResult,
  startTrigger = 0,
}: ShiftVoiceRecorderProps) {
  return (
    <VoiceRecorderOverlay
      onResult={onResult}
      recordingHints={RECORDING_HINT_LINES.slice(1)}
      recordingTitle={RECORDING_HINT_LINES[0]}
      startTrigger={startTrigger}
      stopLabel="Stop Recording"
      uploadingText="Uploading voice..."
    />
  );
}
