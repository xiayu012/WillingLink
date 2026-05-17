import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  lt,
  or,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ArtifactKind } from "@/components/artifact";
import type { VisibilityType } from "@/components/visibility-selector";
import { ChatSDKError } from "../errors";
import { generateUUID } from "../utils";
import {
  type Chat,
  chat,
  type DBMessage,
  document,
  message,
  type Suggestion,
  shift,
  stream,
  suggestion,
  type User,
  user,
  vote,
  xhsRentalListing,
} from "./schema";
import { generateHashedPassword } from "./utils";

// Optionally, if not using email/pass login, you can
// use the Drizzle adapter for Auth.js / NextAuth
// https://authjs.dev/reference/adapter/drizzle

// biome-ignore lint: Forbidden non-null assertion.
const client = postgres(process.env.POSTGRES_URL!);
const db = drizzle(client);

export async function getUser(email: string): Promise<User[]> {
  try {
    return await db.select().from(user).where(eq(user.email, email));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get user by email"
    );
  }
}

export async function createUser(email: string, password: string) {
  const hashedPassword = generateHashedPassword(password);

  try {
    return await db.insert(user).values({ email, password: hashedPassword });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to create user");
  }
}

export async function createGuestUser() {
  const email = `guest-${Date.now()}`;
  const password = generateHashedPassword(generateUUID());

  try {
    return await db.insert(user).values({ email, password }).returning({
      id: user.id,
      email: user.email,
    });
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to create guest user"
    );
  }
}

export async function saveChat({
  id,
  userId,
  title,
  visibility,
}: {
  id: string;
  userId: string;
  title: string;
  visibility: VisibilityType;
}) {
  try {
    return await db.insert(chat).values({
      id,
      createdAt: new Date(),
      userId,
      title,
      visibility,
    });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save chat");
  }
}

export async function deleteChatById({ id }: { id: string }) {
  try {
    await db.delete(vote).where(eq(vote.chatId, id));
    await db.delete(message).where(eq(message.chatId, id));
    await db.delete(stream).where(eq(stream.chatId, id));

    const [chatsDeleted] = await db
      .delete(chat)
      .where(eq(chat.id, id))
      .returning();
    return chatsDeleted;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete chat by id"
    );
  }
}

export async function deleteAllChatsByUserId({ userId }: { userId: string }) {
  try {
    const userChats = await db
      .select({ id: chat.id })
      .from(chat)
      .where(eq(chat.userId, userId));

    if (userChats.length === 0) {
      return { deletedCount: 0 };
    }

    const chatIds = userChats.map((c) => c.id);

    await db.delete(vote).where(inArray(vote.chatId, chatIds));
    await db.delete(message).where(inArray(message.chatId, chatIds));
    await db.delete(stream).where(inArray(stream.chatId, chatIds));

    const deletedChats = await db
      .delete(chat)
      .where(eq(chat.userId, userId))
      .returning();

    return { deletedCount: deletedChats.length };
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete all chats by user id"
    );
  }
}

export async function getChatsByUserId({
  id,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}) {
  try {
    const extendedLimit = limit + 1;

    const query = (whereCondition?: SQL<any>) =>
      db
        .select()
        .from(chat)
        .where(
          whereCondition
            ? and(whereCondition, eq(chat.userId, id))
            : eq(chat.userId, id)
        )
        .orderBy(desc(chat.createdAt))
        .limit(extendedLimit);

    let filteredChats: Chat[] = [];

    if (startingAfter) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, startingAfter))
        .limit(1);

      if (!selectedChat) {
        throw new ChatSDKError(
          "not_found:database",
          `Chat with id ${startingAfter} not found`
        );
      }

      filteredChats = await query(gt(chat.createdAt, selectedChat.createdAt));
    } else if (endingBefore) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, endingBefore))
        .limit(1);

      if (!selectedChat) {
        throw new ChatSDKError(
          "not_found:database",
          `Chat with id ${endingBefore} not found`
        );
      }

      filteredChats = await query(lt(chat.createdAt, selectedChat.createdAt));
    } else {
      filteredChats = await query();
    }

    const hasMore = filteredChats.length > limit;

    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get chats by user id"
    );
  }
}

export async function getChatById({ id }: { id: string }) {
  try {
    const [selectedChat] = await db.select().from(chat).where(eq(chat.id, id));
    if (!selectedChat) {
      return null;
    }

    return selectedChat;
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to get chat by id");
  }
}

export async function saveMessages({ messages }: { messages: DBMessage[] }) {
  try {
    return await db.insert(message).values(messages);
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save messages");
  }
}

export async function updateMessage({
  id,
  parts,
}: {
  id: string;
  parts: DBMessage["parts"];
}) {
  try {
    return await db.update(message).set({ parts }).where(eq(message.id, id));
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to update message");
  }
}

export async function getMessagesByChatId({ id }: { id: string }) {
  try {
    return await db
      .select()
      .from(message)
      .where(eq(message.chatId, id))
      .orderBy(asc(message.createdAt));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get messages by chat id"
    );
  }
}

export async function voteMessage({
  chatId,
  messageId,
  type,
}: {
  chatId: string;
  messageId: string;
  type: "up" | "down";
}) {
  try {
    const [existingVote] = await db
      .select()
      .from(vote)
      .where(and(eq(vote.messageId, messageId)));

    if (existingVote) {
      return await db
        .update(vote)
        .set({ isUpvoted: type === "up" })
        .where(and(eq(vote.messageId, messageId), eq(vote.chatId, chatId)));
    }
    return await db.insert(vote).values({
      chatId,
      messageId,
      isUpvoted: type === "up",
    });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to vote message");
  }
}

export async function getVotesByChatId({ id }: { id: string }) {
  try {
    return await db.select().from(vote).where(eq(vote.chatId, id));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get votes by chat id"
    );
  }
}

export async function saveDocument({
  id,
  title,
  kind,
  content,
  userId,
}: {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  userId: string;
}) {
  try {
    return await db
      .insert(document)
      .values({
        id,
        title,
        kind,
        content,
        userId,
        createdAt: new Date(),
      })
      .returning();
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save document");
  }
}

export async function getDocumentsById({ id }: { id: string }) {
  try {
    const documents = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(asc(document.createdAt));

    return documents;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get documents by id"
    );
  }
}

export async function getDocumentById({ id }: { id: string }) {
  try {
    const [selectedDocument] = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(desc(document.createdAt));

    return selectedDocument;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get document by id"
    );
  }
}

export async function deleteDocumentsByIdAfterTimestamp({
  id,
  timestamp,
}: {
  id: string;
  timestamp: Date;
}) {
  try {
    await db
      .delete(suggestion)
      .where(
        and(
          eq(suggestion.documentId, id),
          gt(suggestion.documentCreatedAt, timestamp)
        )
      );

    return await db
      .delete(document)
      .where(and(eq(document.id, id), gt(document.createdAt, timestamp)))
      .returning();
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete documents by id after timestamp"
    );
  }
}

export async function saveSuggestions({
  suggestions,
}: {
  suggestions: Suggestion[];
}) {
  try {
    return await db.insert(suggestion).values(suggestions);
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to save suggestions"
    );
  }
}

export async function getSuggestionsByDocumentId({
  documentId,
}: {
  documentId: string;
}) {
  try {
    return await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.documentId, documentId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get suggestions by document id"
    );
  }
}

export async function getMessageById({ id }: { id: string }) {
  try {
    return await db.select().from(message).where(eq(message.id, id));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get message by id"
    );
  }
}

export async function deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp,
}: {
  chatId: string;
  timestamp: Date;
}) {
  try {
    const messagesToDelete = await db
      .select({ id: message.id })
      .from(message)
      .where(
        and(eq(message.chatId, chatId), gte(message.createdAt, timestamp))
      );

    const messageIds = messagesToDelete.map(
      (currentMessage) => currentMessage.id
    );

    if (messageIds.length > 0) {
      await db
        .delete(vote)
        .where(
          and(eq(vote.chatId, chatId), inArray(vote.messageId, messageIds))
        );

      return await db
        .delete(message)
        .where(
          and(eq(message.chatId, chatId), inArray(message.id, messageIds))
        );
    }
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete messages by chat id after timestamp"
    );
  }
}

export async function updateChatVisibilityById({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: "private" | "public";
}) {
  try {
    return await db.update(chat).set({ visibility }).where(eq(chat.id, chatId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to update chat visibility by id"
    );
  }
}

export async function updateChatTitleById({
  chatId,
  title,
}: {
  chatId: string;
  title: string;
}) {
  try {
    return await db.update(chat).set({ title }).where(eq(chat.id, chatId));
  } catch (error) {
    console.warn("Failed to update title for chat", chatId, error);
    return;
  }
}

export async function getMessageCountByUserId({
  id,
  differenceInHours,
}: {
  id: string;
  differenceInHours: number;
}) {
  try {
    const twentyFourHoursAgo = new Date(
      Date.now() - differenceInHours * 60 * 60 * 1000
    );

    const [stats] = await db
      .select({ count: count(message.id) })
      .from(message)
      .innerJoin(chat, eq(message.chatId, chat.id))
      .where(
        and(
          eq(chat.userId, id),
          gte(message.createdAt, twentyFourHoursAgo),
          eq(message.role, "user")
        )
      )
      .execute();

    return stats?.count ?? 0;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get message count by user id"
    );
  }
}

export async function createStreamId({
  streamId,
  chatId,
}: {
  streamId: string;
  chatId: string;
}) {
  try {
    await db
      .insert(stream)
      .values({ id: streamId, chatId, createdAt: new Date() });
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to create stream id"
    );
  }
}

export async function getStreamIdsByChatId({ chatId }: { chatId: string }) {
  try {
    const streamIds = await db
      .select({ id: stream.id })
      .from(stream)
      .where(eq(stream.chatId, chatId))
      .orderBy(asc(stream.createdAt))
      .execute();

    return streamIds.map(({ id }) => id);
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get stream ids by chat id"
    );
  }
}

export async function searchShifts({
  queryEmbedding,
  whattodo,
  startDateFrom,
  startDateTo,
  location,
  skillsNeeded,
  whoIsBeingHelped,
  laborCredits,
}: {
  queryEmbedding: number[];
  whattodo?: string | null;
  startDateFrom?: string | null;
  startDateTo?: string | null;
  location?: string | null;
  skillsNeeded?: string | null;
  whoIsBeingHelped?: string | null;
  laborCredits?: string | null;
}) {
  try {
    const vectorStr = `[${queryEmbedding.join(",")}]`;

    // Use raw SQL for pgvector similarity search + filters. startTime uses range (timestamptz), no ILIKE.
    const rows = await client`
      SELECT
        "id", "whattodo", "startTime", "location", "skillsNeeded",
        "whoIsBeingHelped", "laborCredits", "rawMessage", "audioUrl", "audioDurationMs", "createdAt",
        embedding <=> ${vectorStr}::vector AS distance,
        COUNT(*) OVER() AS total_count
      FROM "Shift"
      WHERE "embedding" IS NOT NULL
        AND (${whattodo ?? null}::text IS NULL OR "whattodo" ILIKE '%' || ${whattodo ?? null} || '%')
        AND (${location ?? null}::text IS NULL OR "location" ILIKE '%' || ${location ?? null} || '%')
        AND "startTime" >= COALESCE(${startDateFrom ?? null}::timestamptz, '-infinity'::timestamptz)
        AND "startTime" <= COALESCE(${startDateTo ?? null}::timestamptz, 'infinity'::timestamptz)
        AND (${skillsNeeded ?? null}::text IS NULL OR "skillsNeeded" ILIKE '%' || ${skillsNeeded ?? null} || '%')
        AND (${whoIsBeingHelped ?? null}::text IS NULL OR "whoIsBeingHelped" ILIKE '%' || ${whoIsBeingHelped ?? null} || '%')
        AND (${laborCredits ?? null}::text IS NULL OR "laborCredits" ILIKE '%' || ${laborCredits ?? null} || '%')
      ORDER BY distance
      LIMIT 10
    `;

    const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0;

    const results = rows.map((row) => ({
      id: row.id as string,
      whattodo: row.whattodo as string | null,
      startTime: row.startTime as Date | null,
      location: row.location as string | null,
      skillsNeeded: row.skillsNeeded as string | null,
      whoIsBeingHelped: row.whoIsBeingHelped as string | null,
      laborCredits: row.laborCredits as string | null,
      rawMessage: row.rawMessage as string,
      audioUrl: row.audioUrl as string | null,
      audioDurationMs: row.audioDurationMs as number | null,
      createdAt: row.createdAt as Date,
      distance: Number(row.distance),
    }));

    return { totalCount, results };
  } catch (_error) {
    console.error("Failed to search shifts:", _error);
    throw new ChatSDKError("bad_request:database", "Failed to search shifts");
  }
}

export async function saveShift({
  id,
  whattodo,
  startTime,
  location,
  skillsNeeded,
  whoIsBeingHelped,
  laborCredits,
  rawMessage,
  embedding,
  audioUrl,
  audioDurationMs,
  audioMimeType,
  audioSizeBytes,
}: {
  id: string;
  whattodo: string | null;
  startTime: string | Date | null;
  location: string | null;
  skillsNeeded: string | null;
  whoIsBeingHelped: string | null;
  laborCredits: string | null;
  rawMessage: string;
  embedding?: number[];
  audioUrl?: string | null;
  audioMimeType?: string | null;
  audioSizeBytes?: number | null;
}) {
  try {
    await db.insert(shift).values({
      id,
      whattodo,
      startTime: startTime ?? null,
      location,
      skillsNeeded,
      whoIsBeingHelped,
      laborCredits,
      rawMessage,
      audioUrl: audioUrl ?? null,
      audioDurationMs: audioDurationMs ?? null,
      audioMimeType: audioMimeType ?? null,
      audioSizeBytes: audioSizeBytes ?? null,
      createdAt: new Date(),
    });

    // Update the embedding column via raw SQL (pgvector type not supported by Drizzle)
    if (embedding) {
      const vectorStr = `[${embedding.join(",")}]`;
      await client`UPDATE "Shift" SET "embedding" = ${vectorStr}::vector WHERE "id" = ${id}`;
    }
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save shift");
  }
}

export async function updateShiftSignUp({
  shiftId,
  signUpUserName,
  signUpAudioUrl,
  signUpAudioDurationMs,
  signUpAudioMimeType,
  signUpAudioSizeBytes,
}: {
  shiftId: string;
  signUpUserName: string;
  signUpAudioUrl: string;
  signUpAudioDurationMs?: number | null;
  signUpAudioMimeType?: string | null;
  signUpAudioSizeBytes?: number | null;
}) {
  const [updated] = await db
    .update(shift)
    .set({
      signUpUserName,
      signUpAudioUrl,
      signUpAudioDurationMs: signUpAudioDurationMs ?? null,
      signUpAudioMimeType: signUpAudioMimeType ?? null,
      signUpAudioSizeBytes: signUpAudioSizeBytes ?? null,
      signUpCreatedAt: new Date(),
    })
    .where(eq(shift.id, shiftId))
    .returning({ id: shift.id });

  return updated ?? null;
}

export type ShiftExportRow = {
  whattodo: string | null;
  startTime: Date | null;
  location: string | null;
  skillsNeeded: string | null;
  whoIsBeingHelped: string | null;
  laborCredits: string | null;
  audioUrl: string | null;
  createdAt: Date;
  signUpUserName: string | null;
  signUpAudioUrl: string | null;
  signUpCreatedAt: Date | null;
};

export async function getShiftsForExport(): Promise<ShiftExportRow[]> {
  const rows = await db
    .select({
      whattodo: shift.whattodo,
      startTime: shift.startTime,
      location: shift.location,
      skillsNeeded: shift.skillsNeeded,
      whoIsBeingHelped: shift.whoIsBeingHelped,
      laborCredits: shift.laborCredits,
      audioUrl: shift.audioUrl,
      createdAt: shift.createdAt,
      signUpUserName: shift.signUpUserName,
      signUpAudioUrl: shift.signUpAudioUrl,
      signUpCreatedAt: shift.signUpCreatedAt,
    })
    .from(shift)
    .where(and(isNotNull(shift.audioUrl), isNotNull(shift.signUpAudioUrl)))
    .orderBy(desc(shift.createdAt));
  return rows;
}

export type ListXhsRentalListingsParams = {
  limit: number;
  offset: number;
  /**
   * 在 title / rawText / locationText / propertyName 上做 ILIKE %…% 包含匹配；
   * 输入中的 % 与 _ 会被去掉，避免通配符注入。
   */
  search?: string | null;
};

/** 只读列出 XhsRentalListing 全列，按 createdAt 新到旧 */
export async function listXhsRentalListings(
  params: ListXhsRentalListingsParams
) {
  const { limit, offset, search } = params;
  const trimmed = search?.trim();
  const safeFragment =
    trimmed && trimmed.length > 0
      ? trimmed.replaceAll("%", "").replaceAll("_", "")
      : "";
  const pattern =
    safeFragment.length > 0 ? `%${safeFragment.slice(0, 500)}%` : null;

  const textOr =
    pattern !== null
      ? or(
          ilike(xhsRentalListing.title, pattern),
          ilike(xhsRentalListing.rawText, pattern),
          ilike(xhsRentalListing.locationText, pattern),
          ilike(xhsRentalListing.propertyName, pattern)
        )
      : null;

  const listBase = db.select().from(xhsRentalListing);
  const listFiltered = textOr !== null ? listBase.where(textOr) : listBase;
  const countBase = db
    .select({ total: count(xhsRentalListing.id) })
    .from(xhsRentalListing);
  const countFiltered = textOr !== null ? countBase.where(textOr) : countBase;

  const [rows, countRows] = await Promise.all([
    listFiltered
      .orderBy(desc(xhsRentalListing.createdAt))
      .limit(limit)
      .offset(offset),
    countFiltered,
  ]);

  return {
    rows,
    total: countRows[0]?.total ?? 0,
  };
}

export type CreateXhsRentalListingInput = {
  sourceUrl: string;
  rawText: string;
  title?: string | null;
  rent?: string | null;
  deposit?: string | null;
  availableFrom?: string | null;
  leaseEndDate?: string | null;
  listingType?: string | null;
  bedrooms?: string | null;
  bathrooms?: string | null;
  roomType?: string | null;
  propertyName?: string | null;
  locationText?: string | null;
  furnished?: string | null;
  contactMethod?: string | null;
};

export async function createXhsRentalListing(
  input: CreateXhsRentalListingInput
) {
  const [row] = await db
    .insert(xhsRentalListing)
    .values({
      sourceUrl: input.sourceUrl,
      rawText: input.rawText,
      title: input.title ?? null,
      rent: input.rent ?? null,
      deposit: input.deposit ?? null,
      availableFrom: input.availableFrom ?? null,
      leaseEndDate: input.leaseEndDate ?? null,
      listingType: input.listingType ?? null,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      roomType: input.roomType ?? null,
      propertyName: input.propertyName ?? null,
      locationText: input.locationText ?? null,
      furnished: input.furnished ?? null,
      contactMethod: input.contactMethod ?? null,
      createdAt: new Date(),
    })
    .returning({ id: xhsRentalListing.id });
  return row ?? null;
}

export type AppendXhsListingImageResult = {
  id: string | null;
  imageUrlsLength: number;
  duplicated: boolean;
  listingFound: boolean;
};

/** 按 sourceUrl 将 Blob 公开 URL 追加到 imageUrls；无记录则返回未命中 */
export async function appendXhsListingImageUrl(
  sourceUrl: string,
  blobPublicUrl: string
): Promise<AppendXhsListingImageResult> {
  const rows = await db
    .select()
    .from(xhsRentalListing)
    .where(eq(xhsRentalListing.sourceUrl, sourceUrl))
    .limit(1);

  const existing = rows[0];
  const list: string[] = Array.isArray(existing?.imageUrls)
    ? [...existing.imageUrls]
    : [];

  if (list.includes(blobPublicUrl)) {
    return {
      id: existing?.id ?? null,
      imageUrlsLength: list.length,
      duplicated: true,
      listingFound: Boolean(existing),
    };
  }

  if (!existing) {
    return {
      id: null,
      imageUrlsLength: 0,
      duplicated: false,
      listingFound: false,
    };
  }

  list.push(blobPublicUrl);
  await db
    .update(xhsRentalListing)
    .set({ imageUrls: list })
    .where(eq(xhsRentalListing.id, existing.id));

  return {
    id: existing.id,
    imageUrlsLength: list.length,
    duplicated: false,
    listingFound: true,
  };
}
