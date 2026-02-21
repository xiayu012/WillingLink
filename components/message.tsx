"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import equal from "fast-deep-equal";
import { memo, useState } from "react";
import type { Vote } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { useDataStream } from "./data-stream-provider";
import { DocumentToolResult } from "./document";
import { DocumentPreview } from "./document-preview";
import { MessageContent } from "./elements/message";
import { Response } from "./elements/response";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "./elements/tool";
import { SparklesIcon } from "./icons";
import { MessageActions } from "./message-actions";
import { MessageEditor } from "./message-editor";
import { MessageReasoning } from "./message-reasoning";
import { PreviewAttachment } from "./preview-attachment";
import { Weather } from "./weather";
import { AudioPlayer, VoiceMessageBubble } from "./audio-player";

const AUDIO_META_REGEX =
  /\[AUDIO_META:\s*url=([^\s\]]+)\s+duration=(\d+)\s+mime=[^\s\]]+\s+size=\d+\]/i;

const SIGN_UP_PLACEHOLDER_REGEX = /\[__SIGN_UP__:id=([^\]]+)\]/g;

type SignUpSegment = { type: "text"; value: string } | { type: "signUp"; shiftId: string };

function parseAssistantTextWithSignUpButtons(raw: string): SignUpSegment[] {
  const segments: SignUpSegment[] = [];
  let lastEnd = 0;
  for (const match of raw.matchAll(SIGN_UP_PLACEHOLDER_REGEX)) {
    const textPart = raw.slice(lastEnd, match.index);
    if (textPart.length > 0) {
      segments.push({ type: "text", value: textPart });
    }
    segments.push({ type: "signUp", shiftId: match[1] ?? "" });
    lastEnd = (match.index ?? 0) + (match[0]?.length ?? 0);
  }
  const tail = raw.slice(lastEnd);
  if (tail.length > 0) {
    segments.push({ type: "text", value: tail });
  }
  return segments.length > 0 ? segments : [{ type: "text", value: raw }];
}

function parseUserTextWithAudio(
  raw: string,
): { text: string; audioUrl: string | null; durationMs: number } {
  const trimmed = raw.trim();
  const match = trimmed.match(AUDIO_META_REGEX);
  if (!match) {
    return { text: trimmed, audioUrl: null, durationMs: 0 };
  }
  const text = trimmed.replace(AUDIO_META_REGEX, "").trim();
  return {
    text,
    audioUrl: match[1] ?? null,
    durationMs: Number.parseInt(match[2] ?? "0", 10),
  };
}

const PurePreviewMessage = ({
  addToolApprovalResponse,
  chatId,
  message,
  vote,
  isLoading,
  setMessages,
  regenerate,
  isReadonly,
  requiresScrollPadding: _requiresScrollPadding,
  onSignUpClick,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  chatId: string;
  message: ChatMessage;
  vote: Vote | undefined;
  isLoading: boolean;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  requiresScrollPadding: boolean;
  onSignUpClick?: (shiftId: string) => void;
}) => {
  const [mode, setMode] = useState<"view" | "edit">("view");

  const attachmentsFromMessage = message.parts.filter(
    (part) => part.type === "file"
  );

  useDataStream();

  return (
    <div
      className="group/message fade-in w-full animate-in duration-200"
      data-role={message.role}
      data-testid={`message-${message.role}`}
    >
      <div
        className={cn("flex w-full items-start gap-2 md:gap-3", {
          "justify-end": message.role === "user" && mode !== "edit",
          "justify-start": message.role === "assistant",
        })}
      >
        {message.role === "assistant" && (
          <div className="-mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
            <SparklesIcon size={14} />
          </div>
        )}

        <div
          className={cn("flex flex-col", {
            "gap-2 md:gap-4": message.parts?.some(
              (p) => p.type === "text" && p.text?.trim()
            ),
            "w-full":
              (message.role === "assistant" &&
                (message.parts?.some(
                  (p) => p.type === "text" && p.text?.trim()
                ) ||
                  message.parts?.some((p) => p.type.startsWith("tool-")))) ||
              mode === "edit",
            "max-w-[calc(100%-2.5rem)] sm:max-w-[min(fit-content,80%)]":
              message.role === "user" && mode !== "edit",
          })}
        >
          {attachmentsFromMessage.length > 0 && (
            <div
              className="flex flex-row justify-end gap-2"
              data-testid={"message-attachments"}
            >
              {attachmentsFromMessage.map((attachment) => (
                <PreviewAttachment
                  attachment={{
                    name: attachment.filename ?? "file",
                    contentType: attachment.mediaType,
                    url: attachment.url,
                  }}
                  key={attachment.url}
                />
              ))}
            </div>
          )}

          {message.parts?.map((part, index) => {
            const { type } = part;
            const key = `message-${message.id}-part-${index}`;

            if (type === "reasoning" && part.text?.trim().length > 0) {
              return (
                <MessageReasoning
                  isLoading={isLoading}
                  key={key}
                  reasoning={part.text}
                />
              );
            }

            if (type === "text") {
              if (mode === "view") {
                const rawText = part.text ?? "";
                const isUser = message.role === "user";

                if (isUser) {
                  const { text: displayText, audioUrl, durationMs } =
                    parseUserTextWithAudio(rawText);

                  return (
                    <div
                      className="flex flex-col items-end gap-1.5"
                      key={key}
                    >
                      {audioUrl && (
                        <VoiceMessageBubble
                          className="bg-[#006cff] text-white"
                          durationMs={durationMs}
                          src={audioUrl}
                        />
                      )}
                      {displayText ? (
                        <MessageContent
                          className="wrap-break-word w-fit rounded-2xl px-3 py-2 text-right text-white"
                          data-testid="message-content"
                          style={{ backgroundColor: "#006cff" }}
                        >
                          <Response>{sanitizeText(displayText)}</Response>
                        </MessageContent>
                      ) : null}
                    </div>
                  );
                }

                const text = sanitizeText(rawText);
                const segments = parseAssistantTextWithSignUpButtons(text);
                const hasSignUpButtons =
                  segments.some((s) => s.type === "signUp") &&
                  typeof onSignUpClick === "function";

                const shiftAudioMap = new Map<
                  string,
                  { audioUrl: string; durationMs: number }
                >();
                for (const p of message.parts ?? []) {
                  if (p.type !== "tool-searchShift") continue;
                  const toolPart = p as {
                    state?: string;
                    output?: {
                      results?: Array<{
                        id: string;
                        audioUrl?: string | null;
                        audioDurationMs?: number | null;
                      }>;
                    };
                  };
                  if (
                    toolPart.state !== "output-available" ||
                    !toolPart.output?.results
                  )
                    continue;
                  for (const r of toolPart.output.results) {
                    if (r.id && r.audioUrl) {
                      shiftAudioMap.set(r.id, {
                        audioUrl: r.audioUrl,
                        durationMs: r.audioDurationMs ?? 0,
                      });
                    }
                  }
                }

                const audioLinkRegex =
                  /\[(?:Play audio|🔊[^\]]*|Voice[^\]]*)\]\((https?:\/\/[^\s)]+\.(?:webm|mp4|mpeg|ogg|wav)[^\s)]*)\)/gi;
                const audioUrls: string[] = [];
                let match: RegExpExecArray | null;
                audioLinkRegex.lastIndex = 0;
                while ((match = audioLinkRegex.exec(text)) !== null) {
                  audioUrls.push(match[1]);
                }

                return (
                  <div key={key}>
                    <MessageContent
                      className="bg-transparent px-0 py-0 text-left"
                      data-testid="message-content"
                    >
                      {hasSignUpButtons ? (
                        <span className="contents">
                          {segments.map((seg, i) =>
                            seg.type === "text" ? (
                              <Response key={`t-${i}`}>{seg.value}</Response>
                            ) : (
                              <span
                                className="ml-1 inline-flex shrink-0 items-center gap-2"
                                key={`s-${i}-${seg.shiftId}`}
                              >
                                {shiftAudioMap.get(seg.shiftId)?.audioUrl && (
                                  <VoiceMessageBubble
                                    autoPlay={
                                      segments.findIndex(
                                        (s) =>
                                          s.type === "signUp" &&
                                          shiftAudioMap.has(s.shiftId)
                                      ) === i
                                    }
                                    className="bg-[#006cff] text-white"
                                    durationMs={
                                      shiftAudioMap.get(seg.shiftId)
                                        ?.durationMs ?? 0
                                    }
                                    src={
                                      shiftAudioMap.get(seg.shiftId)
                                        ?.audioUrl ?? ""
                                    }
                                  />
                                )}
                                <button
                                  className="inline-flex shrink-0 rounded-md border border-primary bg-primary/10 px-2 py-1 text-primary text-sm transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  onClick={() =>
                                    onSignUpClick?.(seg.shiftId)
                                  }
                                  onKeyDown={(e) => {
                                    if (
                                      (e.key === "Enter" ||
                                        e.key === " ") &&
                                      !e.defaultPrevented
                                    ) {
                                      e.preventDefault();
                                      onSignUpClick?.(seg.shiftId);
                                    }
                                  }}
                                  type="button"
                                >
                                  Sign up this one
                                </button>
                              </span>
                            )
                          )}
                        </span>
                      ) : (
                        <Response>{text}</Response>
                      )}
                    </MessageContent>
                    {audioUrls.length > 0 && (
                      <div className="mt-2 flex flex-col gap-1">
                        {audioUrls.map((url, i) => (
                          <AudioPlayer
                            autoPlay={i === 0}
                            key={url}
                            label={`Voice recording ${i + 1}`}
                            src={url}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              }

              if (mode === "edit") {
                return (
                  <div
                    className="flex w-full flex-row items-start gap-3"
                    key={key}
                  >
                    <div className="size-8" />
                    <div className="min-w-0 flex-1">
                      <MessageEditor
                        key={message.id}
                        message={message}
                        regenerate={regenerate}
                        setMessages={setMessages}
                        setMode={setMode}
                      />
                    </div>
                  </div>
                );
              }
            }

            if (type === "tool-getWeather") {
              const { toolCallId, state } = part;
              const approvalId = (part as { approval?: { id: string } })
                .approval?.id;
              const isDenied =
                state === "output-denied" ||
                (state === "approval-responded" &&
                  (part as { approval?: { approved?: boolean } }).approval
                    ?.approved === false);
              const widthClass = "w-[min(100%,450px)]";

              if (state === "output-available") {
                return (
                  <div className={widthClass} key={toolCallId}>
                    <Weather weatherAtLocation={part.output} />
                  </div>
                );
              }

              if (isDenied) {
                return (
                  <div className={widthClass} key={toolCallId}>
                    <Tool className="w-full" defaultOpen={true}>
                      <ToolHeader
                        state="output-denied"
                        type="tool-getWeather"
                      />
                      <ToolContent>
                        <div className="px-4 py-3 text-muted-foreground text-sm">
                          Weather lookup was denied.
                        </div>
                      </ToolContent>
                    </Tool>
                  </div>
                );
              }

              if (state === "approval-responded") {
                return (
                  <div className={widthClass} key={toolCallId}>
                    <Tool className="w-full" defaultOpen={true}>
                      <ToolHeader state={state} type="tool-getWeather" />
                      <ToolContent>
                        <ToolInput input={part.input} />
                      </ToolContent>
                    </Tool>
                  </div>
                );
              }

              return (
                <div className={widthClass} key={toolCallId}>
                  <Tool className="w-full" defaultOpen={true}>
                    <ToolHeader state={state} type="tool-getWeather" />
                    <ToolContent>
                      {(state === "input-available" ||
                        state === "approval-requested") && (
                        <ToolInput input={part.input} />
                      )}
                      {state === "approval-requested" && approvalId && (
                        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
                          <button
                            className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
                            onClick={() => {
                              addToolApprovalResponse({
                                id: approvalId,
                                approved: false,
                                reason: "User denied weather lookup",
                              });
                            }}
                            type="button"
                          >
                            Deny
                          </button>
                          <button
                            className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm transition-colors hover:bg-primary/90"
                            onClick={() => {
                              addToolApprovalResponse({
                                id: approvalId,
                                approved: true,
                              });
                            }}
                            type="button"
                          >
                            Allow
                          </button>
                        </div>
                      )}
                    </ToolContent>
                  </Tool>
                </div>
              );
            }

            if (type === "tool-createDocument") {
              const { toolCallId } = part;

              if (part.output && "error" in part.output) {
                return (
                  <div
                    className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
                    key={toolCallId}
                  >
                    Error creating document: {String(part.output.error)}
                  </div>
                );
              }

              return (
                <DocumentPreview
                  isReadonly={isReadonly}
                  key={toolCallId}
                  result={part.output}
                />
              );
            }

            if (type === "tool-updateDocument") {
              const { toolCallId } = part;

              if (part.output && "error" in part.output) {
                return (
                  <div
                    className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
                    key={toolCallId}
                  >
                    Error updating document: {String(part.output.error)}
                  </div>
                );
              }

              return (
                <div className="relative" key={toolCallId}>
                  <DocumentPreview
                    args={{ ...part.output, isUpdate: true }}
                    isReadonly={isReadonly}
                    result={part.output}
                  />
                </div>
              );
            }

            if (type === "tool-requestSuggestions") {
              const { toolCallId, state } = part;

              return (
                <Tool defaultOpen={true} key={toolCallId}>
                  <ToolHeader state={state} type="tool-requestSuggestions" />
                  <ToolContent>
                    {state === "input-available" && (
                      <ToolInput input={part.input} />
                    )}
                    {state === "output-available" && (
                      <ToolOutput
                        errorText={undefined}
                        output={
                          "error" in part.output ? (
                            <div className="rounded border p-2 text-red-500">
                              Error: {String(part.output.error)}
                            </div>
                          ) : (
                            <DocumentToolResult
                              isReadonly={isReadonly}
                              result={part.output}
                              type="request-suggestions"
                            />
                          )
                        }
                      />
                    )}
                  </ToolContent>
                </Tool>
              );
            }

            return null;
          })}

          {!isReadonly && (
            <MessageActions
              chatId={chatId}
              isLoading={isLoading}
              key={`action-${message.id}`}
              message={message}
              setMode={setMode}
              vote={vote}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export const PreviewMessage = memo(
  PurePreviewMessage,
  (prevProps, nextProps) => {
    if (
      prevProps.isLoading === nextProps.isLoading &&
      prevProps.message.id === nextProps.message.id &&
      prevProps.requiresScrollPadding === nextProps.requiresScrollPadding &&
      equal(prevProps.message.parts, nextProps.message.parts) &&
      equal(prevProps.vote, nextProps.vote) &&
      prevProps.onSignUpClick === nextProps.onSignUpClick
    ) {
      return true;
    }
    return false;
  }
);

export const ThinkingMessage = () => {
  return (
    <div
      className="group/message fade-in w-full animate-in duration-300"
      data-role="assistant"
      data-testid="message-assistant-loading"
    >
      <div className="flex items-start justify-start gap-3">
        <div className="-mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
          <div className="animate-pulse">
            <SparklesIcon size={14} />
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 md:gap-4">
          <div className="flex items-center gap-1 p-0 text-muted-foreground text-sm">
            <span className="animate-pulse">Thinking</span>
            <span className="inline-flex">
              <span className="animate-bounce [animation-delay:0ms]">.</span>
              <span className="animate-bounce [animation-delay:150ms]">.</span>
              <span className="animate-bounce [animation-delay:300ms]">.</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
