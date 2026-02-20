"use client";

import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
// import { useRouter } from "next/navigation";
import { memo } from "react";
// import { useWindowSize } from "usehooks-ts";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
// PlusIcon was used by New Chat button below (commented out)
// import { useSidebar } from "./ui/sidebar";
import { VisibilitySelector, type VisibilityType } from "./visibility-selector";

function PureChatHeader({
  chatId,
  selectedVisibilityType,
  isReadonly,
}: {
  chatId: string;
  selectedVisibilityType: VisibilityType;
  isReadonly: boolean;
}) {
  // Uncomment together with the New Chat button block below if restoring it
  // const router = useRouter();
  // const { open } = useSidebar();
  // const { width: windowWidth } = useWindowSize();

  return (
    <header className="sticky top-0 flex items-center gap-2 bg-background px-2 py-1.5 md:px-2">
      <Button
        asChild
        aria-label="Back to home"
        className="h-16 w-16 min-h-16 min-w-16 max-h-16 max-w-16 shrink-0 grow-0 rounded-full p-0 [&_svg]:size-8 shadow-[0_2px_12px_rgba(120,113,108,0.07)] transition-[transform,box-shadow] duration-200 ease-out hover:scale-105 hover:shadow-[0_4px_20px_rgba(120,113,108,0.12)] active:scale-95 focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:ring-offset-2 dark:shadow-[0_4px_20px_rgba(0,0,0,0.25)] dark:hover:shadow-[0_6px_28px_rgba(0,0,0,0.4)]"
        title="Back to home"
        variant="ghost"
      >
        <Link
          className="flex size-full min-h-16 min-w-16 max-h-16 max-w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-stone-100 to-stone-200/90 text-stone-600 ring-1 ring-stone-300/60 transition-colors hover:from-stone-200 hover:to-stone-300/90 hover:text-stone-800 dark:from-slate-800 dark:to-slate-800/95 dark:text-slate-200 dark:ring-slate-600/50 dark:hover:from-slate-700 dark:hover:to-slate-700/95 dark:hover:text-slate-50"
          href="/"
        >
          <ArrowLeftIcon className="size-8" aria-hidden />
          <span className="sr-only">Back to home</span>
        </Link>
      </Button>
      <SidebarToggle />

      {/* New Chat button (hidden per product request). Restore by uncommenting this block and the hooks/imports above.
      {(!open || windowWidth < 768) && (
        <Button
          className="order-2 ml-auto h-8 px-2 md:order-1 md:ml-0 md:h-fit md:px-2"
          onClick={() => {
            router.push("/");
            router.refresh();
          }}
          variant="outline"
        >
          <PlusIcon />
          <span className="md:sr-only">New Chat</span>
        </Button>
      )} */}

      {!isReadonly && (
        <VisibilitySelector
          chatId={chatId}
          className="order-1 md:order-2"
          selectedVisibilityType={selectedVisibilityType}
        />
      )}
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader, (prevProps, nextProps) => {
  return (
    prevProps.chatId === nextProps.chatId &&
    prevProps.selectedVisibilityType === nextProps.selectedVisibilityType &&
    prevProps.isReadonly === nextProps.isReadonly
  );
});
