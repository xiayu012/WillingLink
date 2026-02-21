"use client";

import { cn } from "@/lib/utils";
import { PauseIcon, PlayIcon, Volume2Icon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";

type AudioPlayerProps = {
  src: string;
  autoPlay?: boolean;
  onEnded?: () => void;
  label?: string;
};

function PureAudioPlayer({
  src,
  autoPlay = false,
  onEnded,
  label,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch(() => {});
    }
  }, [isPlaying]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => {
      setProgress(audio.currentTime);
    };
    const onLoadedMetadata = () => {
      setDuration(audio.duration);
    };
    const onEndedHandler = () => {
      setIsPlaying(false);
      setProgress(0);
      onEnded?.();
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEndedHandler);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEndedHandler);
    };
  }, [onEnded]);

  useEffect(() => {
    if (autoPlay && audioRef.current) {
      audioRef.current.play().catch(() => {});
    }
  }, [autoPlay]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const progressPercent = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <div className="my-1 flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <audio ref={audioRef} src={src} preload="metadata" />
      <Button
        className="size-7 shrink-0 rounded-full p-0"
        onClick={togglePlay}
        size="sm"
        type="button"
        variant="ghost"
      >
        {isPlaying ? (
          <PauseIcon className="size-3.5" />
        ) : (
          <PlayIcon className="size-3.5" />
        )}
      </Button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {label && (
          <span className="flex items-center gap-1 text-muted-foreground text-xs">
            <Volume2Icon className="size-3" />
            {label}
          </span>
        )}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-150"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {formatTime(progress)} / {formatTime(duration)}
      </span>
    </div>
  );
}

export const AudioPlayer = memo(PureAudioPlayer);

type AudioPlayerQueueProps = {
  urls: { src: string; label?: string }[];
  autoPlay?: boolean;
};

function PureAudioPlayerQueue({ urls, autoPlay = false }: AudioPlayerQueueProps) {
  const [currentIndex, setCurrentIndex] = useState(0);

  const handleEnded = useCallback(() => {
    setCurrentIndex((prev) => prev + 1);
  }, []);

  return (
    <div className="flex flex-col gap-1">
      {urls.map((item, index) => (
        <AudioPlayer
          autoPlay={autoPlay && index === currentIndex}
          key={item.src}
          label={item.label}
          onEnded={index < urls.length - 1 ? handleEnded : undefined}
          src={item.src}
        />
      ))}
    </div>
  );
}

export const AudioPlayerQueue = memo(PureAudioPlayerQueue);

/** Compact voice message bubble: tap to play, shows duration (e.g. 0:06) */
type VoiceMessageBubbleProps = {
  src: string;
  durationMs?: number;
  className?: string;
  autoPlay?: boolean;
};

function PureVoiceMessageBubble({
  src,
  durationMs = 0,
  className,
  autoPlay = false,
}: VoiceMessageBubbleProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (!autoPlay) return;
    const audio = audioRef.current;
    if (audio) {
      audio.play().catch(() => {});
    }
  }, [autoPlay, src]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch(() => {});
    }
  }, [isPlaying]);

  const displayDuration =
    durationMs > 0
      ? `${Math.floor(durationMs / 60_000)}:${Math.floor((durationMs % 60_000) / 1000)
          .toString()
          .padStart(2, "0")}`
      : "0:00";

  return (
    <button
      className={cn(
        "inline-flex items-center gap-2 rounded-2xl px-3 py-2 text-left transition-opacity hover:opacity-90",
        className,
      )}
      onClick={togglePlay}
      type="button"
    >
      <audio
        onEnded={() => setIsPlaying(false)}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        ref={audioRef}
        src={src}
      />
      {isPlaying ? (
        <PauseIcon className="size-4 shrink-0 text-current" />
      ) : (
        <PlayIcon className="size-4 shrink-0 text-current" />
      )}
      <span className="tabular-nums text-sm">{displayDuration}</span>
    </button>
  );
}

export const VoiceMessageBubble = memo(PureVoiceMessageBubble);
