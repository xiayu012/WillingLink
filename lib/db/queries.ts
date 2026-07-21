import "server-only";

import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  or,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

type ArtifactKind = string; // artifact component removed

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
  xhsRentalOther,
  xhsRentalWanted,
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
        kind: kind as "text" | "code" | "image" | "sheet",
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
  audioDurationMs?: number | null;
  audioMimeType?: string | null;
  audioSizeBytes?: number | null;
}) {
  try {
    await db.insert(shift).values({
      id,
      whattodo,
      startTime:
        typeof startTime === "string"
          ? new Date(startTime)
          : (startTime ?? null),
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
  postedAt?: Date | null;
  // LLM-extracted structured fields
  bedroomsNum?: number | null;
  city?: string | null;
  petFriendly?: boolean | null;
  couplesOk?: boolean | null;
  utilitiesIncluded?: boolean | null;
  parkingIncluded?: boolean | null;
};

export type XhsRecordKind = "listing" | "wanted" | "other";

export async function resolveXhsRecordKind(
  recordId: string
): Promise<XhsRecordKind | null> {
  const listingRows = await db
    .select({ id: xhsRentalListing.id })
    .from(xhsRentalListing)
    .where(eq(xhsRentalListing.id, recordId))
    .limit(1);
  if (listingRows[0]) {
    return "listing";
  }

  const wantedRows = await db
    .select({ id: xhsRentalWanted.id })
    .from(xhsRentalWanted)
    .where(eq(xhsRentalWanted.id, recordId))
    .limit(1);
  if (wantedRows[0]) {
    return "wanted";
  }

  const otherRows = await db
    .select({ id: xhsRentalOther.id })
    .from(xhsRentalOther)
    .where(eq(xhsRentalOther.id, recordId))
    .limit(1);
  if (otherRows[0]) {
    return "other";
  }

  return null;
}

export type UpdateXhsSourceUrlResult = {
  id: string;
  sourceUrl: string;
  duplicate: boolean;
};

/**
 * Attach a real sourceUrl to a pending row. If that sourceUrl already
 * belongs to another (previously confirmed) row — the partial unique index
 * on sourceUrl fires — this is a genuine duplicate submission: leave the
 * pending row untouched and hand back the existing row's id instead of
 * throwing an unhandled unique_violation.
 */
export async function updateXhsListingSourceUrl(
  listingId: string,
  sourceUrl: string
): Promise<UpdateXhsSourceUrlResult | null> {
  try {
    const [row] = await db
      .update(xhsRentalListing)
      .set({ sourceUrl })
      .where(eq(xhsRentalListing.id, listingId))
      .returning({
        id: xhsRentalListing.id,
        sourceUrl: xhsRentalListing.sourceUrl,
      });
    return row ? { ...row, duplicate: false } : null;
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    const [existing] = await db
      .select({
        id: xhsRentalListing.id,
        sourceUrl: xhsRentalListing.sourceUrl,
      })
      .from(xhsRentalListing)
      .where(eq(xhsRentalListing.sourceUrl, sourceUrl))
      .limit(1);
    return existing ? { ...existing, duplicate: true } : null;
  }
}

export async function updateXhsWantedSourceUrl(
  wantedId: string,
  sourceUrl: string
): Promise<UpdateXhsSourceUrlResult | null> {
  try {
    const [row] = await db
      .update(xhsRentalWanted)
      .set({ sourceUrl })
      .where(eq(xhsRentalWanted.id, wantedId))
      .returning({
        id: xhsRentalWanted.id,
        sourceUrl: xhsRentalWanted.sourceUrl,
      });
    return row ? { ...row, duplicate: false } : null;
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    const [existing] = await db
      .select({ id: xhsRentalWanted.id, sourceUrl: xhsRentalWanted.sourceUrl })
      .from(xhsRentalWanted)
      .where(eq(xhsRentalWanted.sourceUrl, sourceUrl))
      .limit(1);
    return existing ? { ...existing, duplicate: true } : null;
  }
}

export async function updateXhsOtherSourceUrl(
  otherId: string,
  sourceUrl: string
): Promise<UpdateXhsSourceUrlResult | null> {
  try {
    const [row] = await db
      .update(xhsRentalOther)
      .set({ sourceUrl })
      .where(eq(xhsRentalOther.id, otherId))
      .returning({
        id: xhsRentalOther.id,
        sourceUrl: xhsRentalOther.sourceUrl,
      });
    return row ? { ...row, duplicate: false } : null;
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    const [existing] = await db
      .select({ id: xhsRentalOther.id, sourceUrl: xhsRentalOther.sourceUrl })
      .from(xhsRentalOther)
      .where(eq(xhsRentalOther.sourceUrl, sourceUrl))
      .limit(1);
    return existing ? { ...existing, duplicate: true } : null;
  }
}

export async function updateXhsRecordSourceUrl(
  recordId: string,
  sourceUrl: string,
  kind?: XhsRecordKind | null
) {
  const resolvedKind = kind ?? (await resolveXhsRecordKind(recordId));
  if (resolvedKind === "wanted") {
    return updateXhsWantedSourceUrl(recordId, sourceUrl);
  }
  if (resolvedKind === "other") {
    return updateXhsOtherSourceUrl(recordId, sourceUrl);
  }
  if (resolvedKind === "listing") {
    return updateXhsListingSourceUrl(recordId, sourceUrl);
  }
  return null;
}

export async function appendXhsListingImageById(
  listingId: string,
  blobPublicUrl: string
): Promise<AppendXhsListingImageResult> {
  const rows = await db
    .select()
    .from(xhsRentalListing)
    .where(eq(xhsRentalListing.id, listingId))
    .limit(1);

  const existing = rows[0];
  if (!existing) {
    return {
      id: null,
      imageUrlsLength: 0,
      duplicated: false,
      listingFound: false,
    };
  }

  const list: string[] = Array.isArray(existing.imageUrls)
    ? [...existing.imageUrls]
    : [];

  if (list.includes(blobPublicUrl)) {
    return {
      id: existing.id,
      imageUrlsLength: list.length,
      duplicated: true,
      listingFound: true,
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

export async function appendXhsWantedImageById(
  wantedId: string,
  blobPublicUrl: string
): Promise<AppendXhsListingImageResult> {
  const rows = await db
    .select()
    .from(xhsRentalWanted)
    .where(eq(xhsRentalWanted.id, wantedId))
    .limit(1);

  const existing = rows[0];
  if (!existing) {
    return {
      id: null,
      imageUrlsLength: 0,
      duplicated: false,
      listingFound: false,
    };
  }

  const list: string[] = Array.isArray(existing.imageUrls)
    ? [...existing.imageUrls]
    : [];

  if (list.includes(blobPublicUrl)) {
    return {
      id: existing.id,
      imageUrlsLength: list.length,
      duplicated: true,
      listingFound: true,
    };
  }

  list.push(blobPublicUrl);
  await db
    .update(xhsRentalWanted)
    .set({ imageUrls: list })
    .where(eq(xhsRentalWanted.id, existing.id));

  return {
    id: existing.id,
    imageUrlsLength: list.length,
    duplicated: false,
    listingFound: true,
  };
}

export async function appendXhsOtherImageById(
  otherId: string,
  blobPublicUrl: string
): Promise<AppendXhsListingImageResult> {
  const rows = await db
    .select()
    .from(xhsRentalOther)
    .where(eq(xhsRentalOther.id, otherId))
    .limit(1);

  const existing = rows[0];
  if (!existing) {
    return {
      id: null,
      imageUrlsLength: 0,
      duplicated: false,
      listingFound: false,
    };
  }

  const list: string[] = Array.isArray(existing.imageUrls)
    ? [...existing.imageUrls]
    : [];

  if (list.includes(blobPublicUrl)) {
    return {
      id: existing.id,
      imageUrlsLength: list.length,
      duplicated: true,
      listingFound: true,
    };
  }

  list.push(blobPublicUrl);
  await db
    .update(xhsRentalOther)
    .set({ imageUrls: list })
    .where(eq(xhsRentalOther.id, existing.id));

  return {
    id: existing.id,
    imageUrlsLength: list.length,
    duplicated: false,
    listingFound: true,
  };
}

export async function appendXhsRecordImageById(
  recordId: string,
  blobPublicUrl: string,
  kind?: XhsRecordKind | null
): Promise<AppendXhsListingImageResult> {
  const resolvedKind = kind ?? (await resolveXhsRecordKind(recordId));
  if (resolvedKind === "wanted") {
    return appendXhsWantedImageById(recordId, blobPublicUrl);
  }
  if (resolvedKind === "other") {
    return appendXhsOtherImageById(recordId, blobPublicUrl);
  }
  if (resolvedKind === "listing") {
    return appendXhsListingImageById(recordId, blobPublicUrl);
  }
  return {
    id: null,
    imageUrlsLength: 0,
    duplicated: false,
    listingFound: false,
  };
}

/**
 * SHA-256 of rawText (hex). Used for content-based deduplication —
 * catches the same post being submitted again before a real share URL
 * (sourceUrl starts with "pending:...") has been captured.
 */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** True if err is a Postgres unique_violation (23505), e.g. from onConflictDoNothing-less UPDATE. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

export type CreateXhsRecordResult = { id: string; duplicate: boolean };

export type CreateXhsRentalOtherInput = {
  sourceUrl: string;
  rawText: string;
  title?: string | null;
  aiReason?: string | null;
  postedAt?: Date | null;
};

/**
 * Insert a "other" post. Deduplicated on (sourceUrl) and (contentHash of rawText):
 * a matching real sourceUrl, or identical rawText submitted again while still
 * "pending:", silently resolves to the existing row instead of erroring or
 * inserting a duplicate.
 */
export async function createXhsRentalOther(
  input: CreateXhsRentalOtherInput
): Promise<CreateXhsRecordResult | null> {
  const contentHash = sha256(input.rawText);
  const [row] = await db
    .insert(xhsRentalOther)
    .values({
      sourceUrl: input.sourceUrl,
      rawText: input.rawText,
      title: input.title ?? null,
      aiReason: input.aiReason ?? null,
      postedAt: input.postedAt ?? null,
      createdAt: new Date(),
      contentHash,
    })
    .onConflictDoNothing()
    .returning({ id: xhsRentalOther.id });

  if (row) {
    return { id: row.id, duplicate: false };
  }

  const isPending = input.sourceUrl.startsWith("pending:");
  const [existing] = await db
    .select({ id: xhsRentalOther.id })
    .from(xhsRentalOther)
    .where(
      isPending
        ? eq(xhsRentalOther.contentHash, contentHash)
        : or(
            eq(xhsRentalOther.sourceUrl, input.sourceUrl),
            eq(xhsRentalOther.contentHash, contentHash)
          )
    )
    .limit(1);
  return existing ? { id: existing.id, duplicate: true } : null;
}

export type CreateXhsRentalWantedInput = {
  sourceUrl: string;
  rawText: string;
  title?: string | null;
  budgetText?: string | null;
  budgetMin?: string | null;
  budgetMax?: string | null;
  preferredLocations?: string | null;
  moveInDate?: string | null;
  leaseDuration?: string | null;
  wantedType?: string | null;
  bedrooms?: string | null;
  bathrooms?: string | null;
  roomType?: string | null;
  furnished?: string | null;
  pets?: string | null;
  occupation?: string | null;
  householdSize?: string | null;
  gender?: string | null;
  requirements?: string | null;
  contactMethod?: string | null;
  aiConfidence?: string | null;
  aiReason?: string | null;
  postedAt?: Date | null;
};

/**
 * Insert a "wanted" post. Same dedup rule as createXhsRentalOther: matching
 * sourceUrl or contentHash resolves to the existing row instead of duplicating.
 */
export async function createXhsRentalWanted(
  input: CreateXhsRentalWantedInput
): Promise<CreateXhsRecordResult | null> {
  const contentHash = sha256(input.rawText);
  const [row] = await db
    .insert(xhsRentalWanted)
    .values({
      sourceUrl: input.sourceUrl,
      rawText: input.rawText,
      title: input.title ?? null,
      budgetText: input.budgetText ?? null,
      budgetMin: input.budgetMin ?? null,
      budgetMax: input.budgetMax ?? null,
      preferredLocations: input.preferredLocations ?? null,
      moveInDate: input.moveInDate ?? null,
      leaseDuration: input.leaseDuration ?? null,
      wantedType: input.wantedType ?? null,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      roomType: input.roomType ?? null,
      furnished: input.furnished ?? null,
      pets: input.pets ?? null,
      occupation: input.occupation ?? null,
      householdSize: input.householdSize ?? null,
      gender: input.gender ?? null,
      requirements: input.requirements ?? null,
      contactMethod: input.contactMethod ?? null,
      aiConfidence: input.aiConfidence ?? null,
      aiReason: input.aiReason ?? null,
      postedAt: input.postedAt ?? null,
      createdAt: new Date(),
      contentHash,
    })
    .onConflictDoNothing()
    .returning({ id: xhsRentalWanted.id });

  if (row) {
    return { id: row.id, duplicate: false };
  }

  const isPending = input.sourceUrl.startsWith("pending:");
  const [existing] = await db
    .select({ id: xhsRentalWanted.id })
    .from(xhsRentalWanted)
    .where(
      isPending
        ? eq(xhsRentalWanted.contentHash, contentHash)
        : or(
            eq(xhsRentalWanted.sourceUrl, input.sourceUrl),
            eq(xhsRentalWanted.contentHash, contentHash)
          )
    )
    .limit(1);
  return existing ? { id: existing.id, duplicate: true } : null;
}

/** Parse monthly rent text to integer (100–15000 USD). Returns null if unparseable. */
function parseRentNumeric(rent: string | null | undefined): number | null {
  if (!rent) return null;
  const m = rent.match(/\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return n >= 100 && n <= 15_000 ? n : null;
}

/**
 * Insert a rental listing. Same dedup rule as createXhsRentalOther: matching
 * sourceUrl or contentHash (SHA-256 of rawText) resolves to the existing row
 * instead of duplicating.
 */
export async function createXhsRentalListing(
  input: CreateXhsRentalListingInput
): Promise<CreateXhsRecordResult | null> {
  const contentHash = sha256(input.rawText);
  const [row] = await db
    .insert(xhsRentalListing)
    .values({
      sourceUrl: input.sourceUrl,
      rawText: input.rawText,
      title: input.title ?? null,
      rent: input.rent ?? null,
      rentNumeric: parseRentNumeric(input.rent),
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
      postedAt: input.postedAt ?? null,
      createdAt: new Date(),
      bedroomsNum: input.bedroomsNum ?? null,
      city: input.city ?? null,
      petFriendly: input.petFriendly ?? null,
      couplesOk: input.couplesOk ?? null,
      utilitiesIncluded: input.utilitiesIncluded ?? null,
      parkingIncluded: input.parkingIncluded ?? null,
      contentHash,
    })
    .onConflictDoNothing()
    .returning({ id: xhsRentalListing.id });

  if (row) {
    return { id: row.id, duplicate: false };
  }

  const isPending = input.sourceUrl.startsWith("pending:");
  const [existing] = await db
    .select({ id: xhsRentalListing.id })
    .from(xhsRentalListing)
    .where(
      isPending
        ? eq(xhsRentalListing.contentHash, contentHash)
        : or(
            eq(xhsRentalListing.sourceUrl, input.sourceUrl),
            eq(xhsRentalListing.contentHash, contentHash)
          )
    )
    .limit(1);
  return existing ? { id: existing.id, duplicate: true } : null;
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

// --- Rental search (AI chat tool) ---

export type SearchXhsRentalListingsArgs = {
  bedrooms?: string | null;
  bathrooms?: string | null;
  roomType?: string | null;
  listingType?: string | null;
  furnished?: string | null;
  propertyName?: string | null;
  locationText?: string | null;
  rentMin?: number | null;
  rentMax?: number | null;
  bedroomsMin?: number | null;
  bathroomsMin?: number | null;
  // NOTE: no availableFrom range args here. `availableFrom` is FREE TEXT
  // ("7/1", "ASAP", "8月初"), so SQL string comparison on it is lexicographic,
  // not chronological, and silently wrong. Move-in feasibility is enforced in
  // the app layer via lib/rental/date-availability.ts — the single source of
  // truth. Do not reintroduce a SQL `>=` / `<=` filter on this column.
  /**
   * Free-text keywords — ALL must appear in rawText, title, locationText, or propertyName.
   * Useful for city names, room types, amenities.
   */
  keywords?: string[] | null;
  /**
   * Override the default RENTAL_RESULT_LIMIT (20).
   * Use a higher value for last-resort searches where a wider pool improves reranking quality.
   */
  limit?: number | null;
};

export type XhsRentalSearchResultRow = {
  id: string;
  sourceUrl: string;
  title: string | null;
  rawText: string;
  rent: string | null;
  rentNumeric: number | null;
  deposit: string | null;
  availableFrom: string | null;
  leaseEndDate: string | null;
  listingType: string | null;
  bedrooms: string | null;
  bathrooms: string | null;
  roomType: string | null;
  propertyName: string | null;
  locationText: string | null;
  furnished: string | null;
  contactMethod: string | null;
  imageUrls: string[] | null;
  createdAt: Date;
  // LLM-extracted structured fields
  bedroomsNum: number | null;
  city: string | null;
  petFriendly: boolean | null;
  couplesOk: boolean | null;
  utilitiesIncluded: boolean | null;
  parkingIncluded: boolean | null;
};

const RENTAL_RESULT_LIMIT = 20;

/** pgvector ????????? embedding ????????*/
export async function vectorSearchXhsRentalListings(
  queryEmbedding: number[],
  candidateLimit = 20,
  excludeIds: string[] = []
): Promise<XhsRentalSearchResultRow[]> {
  try {
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const rows =
      excludeIds.length > 0
        ? await client`
            SELECT
              "id", "sourceUrl", "title", "rawText", "rent", "rentNumeric", "deposit",
              "availableFrom", "leaseEndDate", "listingType", "bedrooms", "bathrooms",
              "roomType", "propertyName", "locationText", "furnished", "contactMethod",
              "imageUrls", "createdAt",
              "bedroomsNum", "city", "petFriendly", "couplesOk", "utilitiesIncluded", "parkingIncluded"
            FROM "XhsRentalListing"
            WHERE embedding IS NOT NULL
              AND "id" != ALL(${excludeIds}::uuid[])
            ORDER BY embedding <=> ${vectorLiteral}::vector
            LIMIT ${candidateLimit}
          `
        : await client`
            SELECT
              "id", "sourceUrl", "title", "rawText", "rent", "rentNumeric", "deposit",
              "availableFrom", "leaseEndDate", "listingType", "bedrooms", "bathrooms",
              "roomType", "propertyName", "locationText", "furnished", "contactMethod",
              "imageUrls", "createdAt",
              "bedroomsNum", "city", "petFriendly", "couplesOk", "utilitiesIncluded", "parkingIncluded"
            FROM "XhsRentalListing"
            WHERE embedding IS NOT NULL
            ORDER BY embedding <=> ${vectorLiteral}::vector
            LIMIT ${candidateLimit}
          `;

    return rows.map((row) => ({
      id: row.id as string,
      sourceUrl: row.sourceUrl as string,
      title: (row.title as string | null) ?? null,
      rawText: row.rawText as string,
      rent: (row.rent as string | null) ?? null,
      rentNumeric: (row.rentNumeric as number | null) ?? null,
      deposit: (row.deposit as string | null) ?? null,
      availableFrom: (row.availableFrom as string | null) ?? null,
      leaseEndDate: (row.leaseEndDate as string | null) ?? null,
      listingType: (row.listingType as string | null) ?? null,
      bedrooms: (row.bedrooms as string | null) ?? null,
      bathrooms: (row.bathrooms as string | null) ?? null,
      roomType: (row.roomType as string | null) ?? null,
      propertyName: (row.propertyName as string | null) ?? null,
      locationText: (row.locationText as string | null) ?? null,
      furnished: (row.furnished as string | null) ?? null,
      contactMethod: (row.contactMethod as string | null) ?? null,
      imageUrls: Array.isArray(row.imageUrls)
        ? (row.imageUrls as string[])
        : null,
      createdAt: row.createdAt as Date,
      bedroomsNum: (row.bedroomsNum as number | null) ?? null,
      city: (row.city as string | null) ?? null,
      petFriendly: (row.petFriendly as boolean | null) ?? null,
      couplesOk: (row.couplesOk as boolean | null) ?? null,
      utilitiesIncluded: (row.utilitiesIncluded as boolean | null) ?? null,
      parkingIncluded: (row.parkingIncluded as boolean | null) ?? null,
    }));
  } catch (error) {
    console.error("Failed to vector search XhsRentalListing:", error);
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to vector search rental listings"
    );
  }
}

/** ????????????????????????????????? */
export async function updateListingEmbedding(
  id: string,
  embedding: number[]
): Promise<void> {
  const vectorLiteral = `[${embedding.join(",")}]`;
  await client`
    UPDATE "XhsRentalListing"
    SET embedding = ${vectorLiteral}::vector
    WHERE id = ${id}::uuid
  `;
}

export async function searchXhsRentalListings({
  bedrooms,
  bathrooms,
  roomType,
  listingType,
  furnished,
  propertyName,
  locationText,
  rentMin,
  rentMax,
  bedroomsMin,
  bathroomsMin,
  keywords,
  limit,
}: SearchXhsRentalListingsArgs) {
  try {
    const cleanKeywords = (keywords ?? [])
      .map((k) => (typeof k === "string" ? k.trim() : ""))
      .filter((k) => k.length > 0);

    const rows = await client`
      SELECT
        "id", "sourceUrl", "title", "rawText", "rent", "rentNumeric", "deposit",
        "availableFrom", "leaseEndDate", "listingType", "bedrooms", "bathrooms",
        "roomType", "propertyName", "locationText", "furnished", "contactMethod",
        "imageUrls", "createdAt",
        "bedroomsNum", "city", "petFriendly", "couplesOk", "utilitiesIncluded", "parkingIncluded",
        COUNT(*) OVER() AS total_count
      FROM "XhsRentalListing"
      WHERE
            (${bedrooms ?? null}::text     IS NULL OR "bedrooms"     ILIKE '%' || ${bedrooms ?? null} || '%')
        AND (${bathrooms ?? null}::text    IS NULL OR "bathrooms"    ILIKE '%' || ${bathrooms ?? null} || '%')
        AND (${roomType ?? null}::text     IS NULL OR "roomType"     ILIKE '%' || ${roomType ?? null} || '%')
        AND (${listingType ?? null}::text  IS NULL OR "listingType"  ILIKE '%' || ${listingType ?? null} || '%')
        AND (${furnished ?? null}::text    IS NULL OR "furnished"    ILIKE '%' || ${furnished ?? null} || '%')
        AND (${propertyName ?? null}::text IS NULL OR "propertyName" ILIKE '%' || ${propertyName ?? null} || '%')
        AND (${locationText ?? null}::text IS NULL OR "locationText" ILIKE '%' || ${locationText ?? null} || '%')
        AND (${rentMin ?? null}::int  IS NULL OR "rentNumeric" >= ${rentMin ?? null}::int)
        AND (${rentMax ?? null}::int  IS NULL OR "rentNumeric" <= ${rentMax ?? null}::int)
        AND (${bedroomsMin ?? null}::int  IS NULL OR COALESCE(NULLIF(substring("bedrooms"  from '\d+'), '')::int, 0) >= ${bedroomsMin ?? null}::int)
        AND (${bathroomsMin ?? null}::int IS NULL OR COALESCE(NULLIF(substring("bathrooms" from '\d+'), '')::int, 0) >= ${bathroomsMin ?? null}::int)
        -- availableFrom is free text; move-in feasibility is enforced in the app
        -- layer (lib/rental/date-availability.ts), never by SQL string compare.
        AND (
          ${cleanKeywords.length === 0}::boolean
          OR (
            SELECT bool_and(
              "rawText"      ILIKE '%' || kw || '%'
              OR COALESCE("title", '')        ILIKE '%' || kw || '%'
              OR COALESCE("locationText", '') ILIKE '%' || kw || '%'
              OR COALESCE("propertyName", '') ILIKE '%' || kw || '%'
            )
            FROM unnest(${cleanKeywords}::text[]) AS kw
          )
        )
      ORDER BY "createdAt" DESC
      LIMIT ${limit ?? RENTAL_RESULT_LIMIT}
    `;

    const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0;

    const results: XhsRentalSearchResultRow[] = rows.map((row) => ({
      id: row.id as string,
      sourceUrl: row.sourceUrl as string,
      title: (row.title as string | null) ?? null,
      rawText: row.rawText as string,
      rent: (row.rent as string | null) ?? null,
      rentNumeric: (row.rentNumeric as number | null) ?? null,
      deposit: (row.deposit as string | null) ?? null,
      availableFrom: (row.availableFrom as string | null) ?? null,
      leaseEndDate: (row.leaseEndDate as string | null) ?? null,
      listingType: (row.listingType as string | null) ?? null,
      bedrooms: (row.bedrooms as string | null) ?? null,
      bathrooms: (row.bathrooms as string | null) ?? null,
      roomType: (row.roomType as string | null) ?? null,
      propertyName: (row.propertyName as string | null) ?? null,
      locationText: (row.locationText as string | null) ?? null,
      furnished: (row.furnished as string | null) ?? null,
      contactMethod: (row.contactMethod as string | null) ?? null,
      imageUrls: Array.isArray(row.imageUrls)
        ? (row.imageUrls as string[])
        : null,
      createdAt: row.createdAt as Date,
      bedroomsNum: (row.bedroomsNum as number | null) ?? null,
      city: (row.city as string | null) ?? null,
      petFriendly: (row.petFriendly as boolean | null) ?? null,
      couplesOk: (row.couplesOk as boolean | null) ?? null,
      utilitiesIncluded: (row.utilitiesIncluded as boolean | null) ?? null,
      parkingIncluded: (row.parkingIncluded as boolean | null) ?? null,
    }));

    return { totalCount, results };
  } catch (error) {
    console.error("Failed to search XhsRentalListing:", error);
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to search rental listings"
    );
  }
}

export type ListingForTransit = {
  id: string;
  locationText: string | null;
  propertyName: string | null;
  title: string | null;
  rent: string | null;
  roomType: string | null;
  bedrooms: string | null;
  sourceUrl: string;
  lat: number | null;
  lng: number | null;
};

/** ????????????????????????????????????? */
export async function getListingsForTransitSearch(): Promise<
  ListingForTransit[]
> {
  try {
    const rows = await client`
      SELECT
        "id", "locationText", "propertyName", "title",
        "rent", "roomType", "bedrooms", "sourceUrl",
        "lat", "lng"
      FROM "XhsRentalListing"
      WHERE "locationText" IS NOT NULL
         OR ("lat" IS NOT NULL AND "lng" IS NOT NULL)
      ORDER BY "createdAt" DESC
    `;
    return rows.map((r) => ({
      id: r.id as string,
      locationText: (r.locationText as string | null) ?? null,
      propertyName: (r.propertyName as string | null) ?? null,
      title: (r.title as string | null) ?? null,
      rent: (r.rent as string | null) ?? null,
      roomType: (r.roomType as string | null) ?? null,
      bedrooms: (r.bedrooms as string | null) ?? null,
      sourceUrl: r.sourceUrl as string,
      lat: r.lat !== null && r.lat !== undefined ? Number(r.lat) : null,
      lng: r.lng !== null && r.lng !== undefined ? Number(r.lng) : null,
    }));
  } catch (error) {
    console.error("Failed to get listings for transit search:", error);
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get listings for transit search"
    );
  }
}

/** ????????????????????*/
export async function updateListingGeocode(
  id: string,
  lat: number,
  lng: number
): Promise<void> {
  try {
    // lat/lng may not exist in current Drizzle schema; use raw SQL to stay forward-compatible
    await client`
      UPDATE "XhsRentalListing"
      SET lat = ${lat}, lng = ${lng}
      WHERE id = ${id}::uuid
    `;
  } catch (error) {
    console.error("Failed to update listing geocode:", error);
  }
}

// ─── XhsRentalWanted (tenant-seeking posts) ──────────────────────────────────

export type XhsRentalWantedSearchResultRow = {
  id: string;
  sourceUrl: string;
  title: string | null;
  rawText: string;
  budgetText: string | null;
  budgetMin: string | null;
  budgetMax: string | null;
  preferredLocations: string | null;
  moveInDate: string | null;
  leaseDuration: string | null;
  wantedType: string | null;
  bedrooms: string | null;
  bathrooms: string | null;
  roomType: string | null;
  furnished: string | null;
  pets: string | null;
  occupation: string | null;
  householdSize: string | null;
  gender: string | null;
  requirements: string | null;
  contactMethod: string | null;
  imageUrls: string[] | null;
  createdAt: Date;
};

type SearchXhsRentalWantedArgs = {
  keywords?: string[] | null;
  preferredLocation?: string | null;
  roomType?: string | null;
  bedrooms?: string | null;
  gender?: string | null;
  pets?: string | null;
  limit?: number | null;
};

const WANTED_RESULT_LIMIT = 20;

export async function searchXhsRentalWanted({
  keywords,
  preferredLocation,
  roomType,
  bedrooms,
  gender,
  pets,
  limit,
}: SearchXhsRentalWantedArgs): Promise<{
  results: XhsRentalWantedSearchResultRow[];
  totalCount: number;
}> {
  const cleanKeywords = (keywords ?? [])
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter((k) => k.length > 0);

  try {
    const rows = await client`
      SELECT
        id, "sourceUrl", title, "rawText",
        "budgetText", "budgetMin", "budgetMax",
        "preferredLocations", "moveInDate", "leaseDuration",
        "wantedType", bedrooms, bathrooms, "roomType",
        furnished, pets, occupation, "householdSize",
        gender, requirements, "contactMethod",
        "imageUrls", "createdAt",
        COUNT(*) OVER() AS total_count
      FROM "XhsRentalWanted"
      WHERE
            (${preferredLocation ?? null}::text IS NULL
             OR "preferredLocations" ILIKE '%' || ${preferredLocation ?? null} || '%'
             OR "rawText"            ILIKE '%' || ${preferredLocation ?? null} || '%'
             OR COALESCE(title, '')  ILIKE '%' || ${preferredLocation ?? null} || '%')
        AND (${roomType ?? null}::text IS NULL OR "roomType" ILIKE '%' || ${roomType ?? null} || '%'
             OR "rawText" ILIKE '%' || ${roomType ?? null} || '%')
        AND (${bedrooms ?? null}::text IS NULL OR bedrooms ILIKE '%' || ${bedrooms ?? null} || '%')
        AND (${gender ?? null}::text IS NULL OR gender ILIKE '%' || ${gender ?? null} || '%')
        AND (${pets ?? null}::text IS NULL OR pets ILIKE '%' || ${pets ?? null} || '%'
             OR "rawText" ILIKE '%' || ${pets ?? null} || '%')
        AND (
          ${cleanKeywords.length === 0}::boolean
          OR (
            SELECT bool_and(
              "rawText"                          ILIKE '%' || kw || '%'
              OR COALESCE(title, '')             ILIKE '%' || kw || '%'
              OR COALESCE("preferredLocations", '') ILIKE '%' || kw || '%'
              OR COALESCE(requirements, '')      ILIKE '%' || kw || '%'
            )
            FROM unnest(${cleanKeywords}::text[]) AS kw
          )
        )
      ORDER BY "createdAt" DESC
      LIMIT ${limit ?? WANTED_RESULT_LIMIT}
    `;

    const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0;

    const results: XhsRentalWantedSearchResultRow[] = rows.map((row) => ({
      id: row.id as string,
      sourceUrl: row.sourceUrl as string,
      title: (row.title as string | null) ?? null,
      rawText: row.rawText as string,
      budgetText: (row.budgetText as string | null) ?? null,
      budgetMin: (row.budgetMin as string | null) ?? null,
      budgetMax: (row.budgetMax as string | null) ?? null,
      preferredLocations: (row.preferredLocations as string | null) ?? null,
      moveInDate: (row.moveInDate as string | null) ?? null,
      leaseDuration: (row.leaseDuration as string | null) ?? null,
      wantedType: (row.wantedType as string | null) ?? null,
      bedrooms: (row.bedrooms as string | null) ?? null,
      bathrooms: (row.bathrooms as string | null) ?? null,
      roomType: (row.roomType as string | null) ?? null,
      furnished: (row.furnished as string | null) ?? null,
      pets: (row.pets as string | null) ?? null,
      occupation: (row.occupation as string | null) ?? null,
      householdSize: (row.householdSize as string | null) ?? null,
      gender: (row.gender as string | null) ?? null,
      requirements: (row.requirements as string | null) ?? null,
      contactMethod: (row.contactMethod as string | null) ?? null,
      imageUrls: Array.isArray(row.imageUrls)
        ? (row.imageUrls as string[])
        : null,
      createdAt: row.createdAt as Date,
    }));

    return { results, totalCount };
  } catch (error) {
    console.error("searchXhsRentalWanted error:", error);
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to search rental wanted posts"
    );
  }
}
