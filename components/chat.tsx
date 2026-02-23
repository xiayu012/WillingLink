"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { ChatHeader } from "@/components/chat-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useArtifactSelector } from "@/hooks/use-artifact";
import { useAutoResume } from "@/hooks/use-auto-resume";
import { useChatVisibility } from "@/hooks/use-chat-visibility";
import type { Vote } from "@/lib/db/schema";
import { ChatSDKError } from "@/lib/errors";
import type { Attachment, ChatMessage } from "@/lib/types";
import { fetcher, fetchWithErrorHandlers, generateUUID } from "@/lib/utils";
import { Artifact } from "./artifact";
import { useDataStream } from "./data-stream-provider";
import { Messages } from "./messages";
import { MultimodalInput } from "./multimodal-input";
import { getChatHistoryPaginationKey } from "./sidebar-history";
import { toast } from "./toast";
import type { VisibilityType } from "./visibility-selector";
import {
  type VoiceRecordResult,
  VoiceRecorderOverlay,
} from "./voice-recorder-overlay";

export function Chat({
  id,
  initialMessages,
  initialChatModel,
  initialVisibilityType,
  isReadonly,
  autoResume,
}: {
  id: string;
  initialMessages: ChatMessage[];
  initialChatModel: string;
  initialVisibilityType: VisibilityType;
  isReadonly: boolean;
  autoResume: boolean;
}) {
  const router = useRouter();

  const { visibilityType } = useChatVisibility({
    chatId: id,
    initialVisibilityType,
  });

  const { mutate } = useSWRConfig();

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      // When user navigates back/forward, refresh to sync with URL
      router.refresh();
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [router]);
  const { setDataStream } = useDataStream();

  const [input, setInput] = useState<string>("");
  const [showCreditCardAlert, setShowCreditCardAlert] = useState(false);
  const [currentModelId, setCurrentModelId] = useState(initialChatModel);
  const currentModelIdRef = useRef(currentModelId);

  useEffect(() => {
    currentModelIdRef.current = currentModelId;
  }, [currentModelId]);

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    resumeStream,
    addToolApprovalResponse,
  } = useChat<ChatMessage>({
    id,
    messages: initialMessages,
    experimental_throttle: 100,
    generateId: generateUUID,
    // Auto-continue after tool approval (only for APPROVED tools)
    // Denied tools don't need server continuation - state is saved on next user message
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const lastMessage = currentMessages.at(-1);
      // Only continue if a tool was APPROVED (not denied)
      const shouldContinue =
        lastMessage?.parts?.some(
          (part) =>
            "state" in part &&
            part.state === "approval-responded" &&
            "approval" in part &&
            (part.approval as { approved?: boolean })?.approved === true
        ) ?? false;
      return shouldContinue;
    },
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: fetchWithErrorHandlers,
      prepareSendMessagesRequest(request) {
        const lastMessage = request.messages.at(-1);
        const isFeedbackMode =
          typeof window !== "undefined" &&
          sessionStorage.getItem("feedbackChatId") === request.id;

        return {
          body: {
            id: request.id,
            // Send the last user message for chat creation/saving
            message:
              lastMessage?.role === "user" ? lastMessage : undefined,
            // Always send all messages for full conversation context
            messages: request.messages,
            selectedChatModel: currentModelIdRef.current,
            selectedVisibilityType: visibilityType,
            ...(isFeedbackMode ? { feedbackMode: true } : {}),
            ...request.body,
          },
        };
      },
    }),
    onData: (dataPart) => {
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));
    },
    onFinish: () => {
      mutate(unstable_serialize(getChatHistoryPaginationKey));
    },
    onError: (error) => {
      if (error instanceof ChatSDKError) {
        // Check if it's a credit card error
        if (
          error.message?.includes("AI Gateway requires a valid credit card")
        ) {
          setShowCreditCardAlert(true);
        } else {
          toast({
            type: "error",
            description: error.message,
          });
        }
      }
    },
  });

  const [pendingSignUp, setPendingSignUp] = useState<{
    shiftId: string;
  } | null>(null);
  const [signUpRecorder, setSignUpRecorder] = useState<{
    shiftId: string;
    userName: string;
  } | null>(null);
  const [signUpRecorderTrigger, setSignUpRecorderTrigger] = useState(0);

  const onSignUpClick = useCallback(
    (shiftId: string) => {
      setPendingSignUp({ shiftId });
      setMessages((prev) => [
        ...prev,
        {
          id: generateUUID(),
          role: "assistant",
          parts: [{ type: "text", text: "What's your name?" }],
        } as ChatMessage,
      ]);
    },
    [setMessages]
  );

  const onSignUpNameSubmit = useCallback(
    (shiftId: string, userName: string) => {
      setSignUpRecorder({ shiftId, userName });
      setSignUpRecorderTrigger((t) => t + 1);
      setMessages((prev) => [
        ...prev,
        {
          id: generateUUID(),
          role: "user",
          parts: [{ type: "text", text: userName }],
        } as ChatMessage,
      ]);
      setPendingSignUp(null);
    },
    [setMessages]
  );

  const handleSignUpRecordResult = useCallback(
    async (data: VoiceRecordResult) => {
      if (!signUpRecorder) return;
      const { shiftId, userName } = signUpRecorder;

      const transcript = (data.transcript ?? "").trim().toLowerCase();
      const transcriptNorm = transcript.replace(/\s+/g, " ");
      const nameNorm = userName.trim().toLowerCase().replace(/\s+/g, " ");
      const nameNoSpaces = nameNorm.replace(/\s/g, "");
      const hasName =
        nameNorm.length > 0 &&
        (transcriptNorm.includes(nameNorm) ||
          (nameNoSpaces.length > 0 && transcriptNorm.includes(nameNoSpaces)));
      const hasSignUp = transcript.includes("sign up");
      if (!transcript || !hasName || !hasSignUp) {
        toast({
          type: "error",
          description: "error: Please say your name",
        });
        setSignUpRecorderTrigger((t) => t + 1);
        return;
      }

      try {
        const res = await fetch(`/api/shifts/${shiftId}/sign-up`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: userName,
            audioUrl: data.audioUrl,
            audioDurationMs: data.durationMs,
            audioMimeType: data.mimeType,
            audioSizeBytes: data.sizeBytes,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error ?? "Update failed");
        }
        setSignUpRecorder(null);
        toast({ type: "success", description: "Sign-up recorded." });
      } catch (err) {
        toast({
          type: "error",
          description:
            err instanceof Error ? err.message : "Failed to save sign-up",
        });
      }
    },
    [signUpRecorder]
  );

  // Post shift 成功后 5 秒自动返回首页（只保留一个定时器，避免触发多次）
  useEffect(() => {
    const hasCreateShiftSuccess = messages.some((m) =>
      m.parts?.some(
        (p) =>
          "type" in p &&
          (p as { type: string }).type === "tool-createShift" &&
          (p as { output?: { success?: boolean } }).output?.success
      )
    );
    if (!hasCreateShiftSuccess) return;
    const t = setTimeout(() => {
      sessionStorage.setItem("skipInputAutoFocus", "1");
      router.replace("/");
      router.refresh();
    }, 5000);
    return () => clearTimeout(t);
  }, [messages, router]);

  const searchParams = useSearchParams();
  const query = searchParams.get("query");

  const [hasAppendedQuery, setHasAppendedQuery] = useState(false);

  useEffect(() => {
    if (query && !hasAppendedQuery) {
      sendMessage({
        role: "user" as const,
        parts: [{ type: "text", text: query }],
      });

      setHasAppendedQuery(true);
      window.history.replaceState({}, "", `/chat/${id}`);
    }
  }, [query, sendMessage, hasAppendedQuery, id]);

  const { data: votes } = useSWR<Vote[]>(
    messages.length >= 2 ? `/api/vote?chatId=${id}` : null,
    fetcher
  );

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const isArtifactVisible = useArtifactSelector((state) => state.isVisible);

  useAutoResume({
    autoResume,
    initialMessages,
    resumeStream,
    setMessages,
  });

  return (
    <>
      {signUpRecorder && (
        <VoiceRecorderOverlay
          onResult={handleSignUpRecordResult}
          recordingTitle={`Please say "${signUpRecorder.userName}" sign up`}
          startTrigger={signUpRecorderTrigger}
          uploadingText="Uploading..."
        />
      )}
      <div className="overscroll-behavior-contain flex h-dvh min-w-0 touch-pan-y flex-col bg-background">
        <ChatHeader
          chatId={id}
          isReadonly={isReadonly}
          selectedVisibilityType={initialVisibilityType}
        />

        <Messages
          addToolApprovalResponse={addToolApprovalResponse}
          chatId={id}
          isArtifactVisible={isArtifactVisible}
          isReadonly={isReadonly}
          messages={messages}
          onSignUpClick={onSignUpClick}
          regenerate={regenerate}
          selectedModelId={initialChatModel}
          setMessages={setMessages}
          status={status}
          votes={votes}
        />

        <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl gap-2 border-t-0 bg-background px-2 pb-3 md:px-4 md:pb-4">
          {!isReadonly && (
            <MultimodalInput
              attachments={attachments}
              chatId={id}
              input={input}
              messages={messages}
              onModelChange={setCurrentModelId}
              onSignUpNameSubmit={onSignUpNameSubmit}
              pendingSignUp={pendingSignUp}
              selectedModelId={currentModelId}
              selectedVisibilityType={visibilityType}
              sendMessage={sendMessage}
              setAttachments={setAttachments}
              setInput={setInput}
              setMessages={setMessages}
              status={status}
              stop={stop}
            />
          )}
        </div>
      </div>

      <Artifact
        addToolApprovalResponse={addToolApprovalResponse}
        attachments={attachments}
        chatId={id}
        input={input}
        isReadonly={isReadonly}
        messages={messages}
        regenerate={regenerate}
        selectedModelId={currentModelId}
        selectedVisibilityType={visibilityType}
        sendMessage={sendMessage}
        setAttachments={setAttachments}
        setInput={setInput}
        setMessages={setMessages}
        status={status}
        stop={stop}
        votes={votes}
      />

      <AlertDialog
        onOpenChange={setShowCreditCardAlert}
        open={showCreditCardAlert}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate AI Gateway</AlertDialogTitle>
            <AlertDialogDescription>
              This application requires{" "}
              {process.env.NODE_ENV === "production" ? "the owner" : "you"} to
              activate Vercel AI Gateway.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                window.open(
                  "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card",
                  "_blank"
                );
                window.location.href = "/";
              }}
            >
              Activate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
