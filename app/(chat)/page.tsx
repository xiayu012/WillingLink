import { cookies } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { Chat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { generateUUID } from "@/lib/utils";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <NewChatPage />
    </Suspense>
  );
}

async function NewChatPage() {
  const cookieStore = await cookies();
  const modelIdFromCookie = cookieStore.get("chat-model");
  const id = generateUUID();

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex-1">
        <Chat
          autoResume={false}
          id={id}
          initialChatModel={
            modelIdFromCookie ? modelIdFromCookie.value : DEFAULT_CHAT_MODEL
          }
          initialMessages={[]}
          initialVisibilityType="private"
          isReadonly={false}
          key={id}
        />
        <DataStreamHandler />
      </div>
      <footer className="border-t px-4 py-3 text-center text-muted-foreground text-xs">
        <Link
          className="mb-2 inline-block rounded bg-primary px-4 py-2 font-medium text-primary-foreground text-sm"
          href="/submit-phone"
        >
          Request rental updates by text
        </Link>
        <div>
          <span className="mr-2">WillingLink Operated by FretGone LLC</span>
          <span className="mr-2">© {new Date().getFullYear()} WillingLink</span>
          <Link className="underline hover:text-foreground" href="/about">
            About
          </Link>
          <span className="mx-1">·</span>
          <Link className="underline hover:text-foreground" href="/terms">
            Terms and Conditions
          </Link>
          <span className="mx-1">·</span>
          <Link className="underline hover:text-foreground" href="/privacy">
            Privacy Policy
          </Link>
        </div>
      </footer>
    </div>
  );
}
