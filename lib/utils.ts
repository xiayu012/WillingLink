import type {
  AssistantModelMessage,
  ToolModelMessage,
  UIMessage,
  UIMessagePart,
} from 'ai';
import { type ClassValue, clsx } from 'clsx';
import { formatISO } from 'date-fns';
import { twMerge } from 'tailwind-merge';
import type { DBMessage } from '@/lib/db/schema';
import { ChatSDKError, type ErrorCode } from './errors';
import type { ChatMessage, ChatTools, CustomUIDataTypes } from './types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fetcher = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    const { code, cause } = await response.json();
    throw new ChatSDKError(code as ErrorCode, cause);
  }

  return response.json();
};

export async function fetchWithErrorHandlers(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  try {
    const response = await fetch(input, init);

    if (!response.ok) {
      const { code, cause } = await response.json();
      throw new ChatSDKError(code as ErrorCode, cause);
    }

    return response;
  } catch (error: unknown) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new ChatSDKError('offline:chat');
    }

    throw error;
  }
}

export function getLocalStorage(key: string) {
  if (typeof window !== 'undefined') {
    return JSON.parse(localStorage.getItem(key) || '[]');
  }
  return [];
}

export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

type ResponseMessageWithoutId = ToolModelMessage | AssistantModelMessage;
type ResponseMessage = ResponseMessageWithoutId & { id: string };

export function getMostRecentUserMessage(messages: UIMessage[]) {
  const userMessages = messages.filter((message) => message.role === 'user');
  return userMessages.at(-1);
}

export function getTrailingMessageId({
  messages,
}: {
  messages: ResponseMessage[];
}): string | null {
  const trailingMessage = messages.at(-1);

  if (!trailingMessage) { return null; }

  return trailingMessage.id;
}

const MEMORY_TAG_RE = /<memory>[\s\S]*?<\/memory>/gi;

/** Untagged memory line the model sometimes outputs without wrapper tags. */
const MEMORY_LINE_RE =
  /\n?\s*language:\s*[a-z]{2}(?:-[a-zA-Z]{2,8})?\s*(?:\|\s*)?[\s\S]*$/i;

export function stripMemoryFromDisplay(text: string): string {
  return text
    .replace("<has_function_call>", "")
    .replace(MEMORY_TAG_RE, "")
    .replace(MEMORY_LINE_RE, "")
    .trim();
}

export function sanitizeText(text: string) {
  return stripMemoryFromDisplay(text);
}

/** Extract the content inside the last <memory>...</memory> block, or null. */
export function extractMemory(text: string): string | null {
  const tagged = [...text.matchAll(/<memory>([\s\S]*?)<\/memory>/gi)];
  if (tagged.length > 0) {
    return tagged.at(-1)?.[1]?.trim() ?? null;
  }

  // Fallback: untagged memory line at end of message
  const untagged = text.match(MEMORY_LINE_RE);
  return untagged?.[0]?.trim() ?? null;
}

/** Extract the `language` field from a memory block string, e.g. "language: zh-CN". */
export function extractLanguageFromMemory(memory: string): string | null {
  const match = memory.match(/\blanguage:\s*([a-zA-Z]{2,8}(?:-[a-zA-Z]{2,8})?)/i);
  return match?.[1]?.trim() ?? null;
}

/** Strip memory from assistant message parts before persisting or displaying. */
export function stripMemoryFromParts(
  parts: ChatMessage["parts"]
): ChatMessage["parts"] {
  return parts.map((part) => {
    if (part.type !== "text") return part;
    const textPart = part as { type: "text"; text: string };
    return { ...textPart, text: stripMemoryFromDisplay(textPart.text ?? "") };
  });
}

export function convertToUIMessages(messages: DBMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role as 'user' | 'assistant' | 'system',
    parts: message.parts as UIMessagePart<CustomUIDataTypes, ChatTools>[],
    metadata: {
      createdAt: formatISO(message.createdAt),
    },
  }));
}

export function getTextFromMessage(message: ChatMessage | UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { type: 'text'; text: string}).text)
    .join('');
}
