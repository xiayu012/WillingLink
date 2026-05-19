import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { VisibilityType } from "@/components/visibility-selector";
import { ChatSDKError } from "../errors";
import { generateUUID } from "../utils";
import {
  type Chat,
  chat,
  type DBMessage,
  message,
  stream,
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

export type SearchXhsRentalListingsArgs = {
  /** 结构化精确筛选（仅在用户明确说时传） */
  bedrooms?: string | null;
  bathrooms?: string | null;
  roomType?: string | null;
  listingType?: string | null;
  furnished?: string | null;
  propertyName?: string | null;
  locationText?: string | null;
  /** 数值范围筛选；rent / bathrooms 是 text 字段，用正则取首个数字再比较 */
  rentMin?: number | null;
  rentMax?: number | null;
  bedroomsMin?: number | null;
  bathroomsMin?: number | null;
  /** 入住时间范围（ISO 日期字符串），availableFrom 是 text 字段 */
  availableFromAfter?: string | null;
  availableFromBefore?: string | null;
  /**
   * 自由文本关键词（处理"刁钻"长尾条件，如"宠物友好/靠近地铁/带阳台"）。
   * 对 rawText/title/locationText/propertyName 四列做 OR 模糊匹配，
   * 关键词之间 AND（必须全部命中至少一列）。
   */
  keywords?: string[] | null;
};

export type XhsRentalSearchResultRow = {
  id: string;
  sourceUrl: string;
  title: string | null;
  rawText: string;
  rent: string | null;
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
};

const RENTAL_RESULT_LIMIT = 20;

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
  availableFromAfter,
  availableFromBefore,
  keywords,
}: SearchXhsRentalListingsArgs) {
  try {
    const cleanKeywords = (keywords ?? [])
      .map((k) => (typeof k === "string" ? k.trim() : ""))
      .filter((k) => k.length > 0);

    const rows = await client`
      SELECT
        "id", "sourceUrl", "title", "rawText", "rent", "deposit",
        "availableFrom", "leaseEndDate", "listingType", "bedrooms", "bathrooms",
        "roomType", "propertyName", "locationText", "furnished", "contactMethod",
        "imageUrls", "createdAt",
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
        AND (${rentMin ?? null}::int  IS NULL OR COALESCE(NULLIF(substring("rent" from '\\d+'), '')::int, 0)  >= ${rentMin ?? null}::int)
        AND (${rentMax ?? null}::int  IS NULL OR COALESCE(NULLIF(substring("rent" from '\\d+'), '')::int, 999999) <= ${rentMax ?? null}::int)
        AND (${bedroomsMin ?? null}::int  IS NULL OR COALESCE(NULLIF(substring("bedrooms"  from '\\d+'), '')::int, 0) >= ${bedroomsMin ?? null}::int)
        AND (${bathroomsMin ?? null}::int IS NULL OR COALESCE(NULLIF(substring("bathrooms" from '\\d+'), '')::int, 0) >= ${bathroomsMin ?? null}::int)
        AND (${availableFromAfter ?? null}::text  IS NULL OR "availableFrom" >= ${availableFromAfter ?? null})
        AND (${availableFromBefore ?? null}::text IS NULL OR "availableFrom" <= ${availableFromBefore ?? null})
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
      LIMIT ${RENTAL_RESULT_LIMIT}
    `;

    const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0;

    const results: XhsRentalSearchResultRow[] = rows.map((row) => ({
      id: row.id as string,
      sourceUrl: row.sourceUrl as string,
      title: (row.title as string | null) ?? null,
      rawText: row.rawText as string,
      rent: (row.rent as string | null) ?? null,
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

/** 获取所有有地址或已经编码的房源，用于通勤时间计算 */
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
      LIMIT 100
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

/** 将地理编码结果缓存回数据库 */
export async function updateListingGeocode(
  id: string,
  lat: number,
  lng: number
): Promise<void> {
  try {
    await db
      .update(xhsRentalListing)
      .set({ lat, lng, geocodedAt: new Date() })
      .where(eq(xhsRentalListing.id, id));
  } catch (error) {
    console.error("Failed to update listing geocode:", error);
  }
}
