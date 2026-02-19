"use client";

import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type CenterOverlayProps = {
  show: boolean;
  children: ReactNode;
  /** Optional class for the inner card */
  className?: string;
};

/**
 * Centered overlay rendered via portal. Backdrop is pointer-events-none so clicks pass through.
 * Inner card is pointer-events-auto. No built-in content—caller provides children.
 */
export function CenterOverlay({
  show,
  children,
  className,
}: CenterOverlayProps) {
  if (typeof document === "undefined" || !show) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
      aria-hidden
    >
      <div
        className={cn(
          "pointer-events-auto max-w-md rounded-2xl px-8 py-6 text-center shadow-lg ring-1 ring-border/50",
          "bg-background/95 backdrop-blur-sm",
          "animate-in fade-in duration-200",
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
