import type { InferSelectModel } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  integer,
  json,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const user = pgTable("User", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  email: varchar("email", { length: 64 }).notNull(),
  password: varchar("password", { length: 64 }),
});

export type User = InferSelectModel<typeof user>;

export const chat = pgTable("Chat", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  createdAt: timestamp("createdAt").notNull(),
  title: text("title").notNull(),
  userId: uuid("userId")
    .notNull()
    .references(() => user.id),
  visibility: varchar("visibility", { enum: ["public", "private"] })
    .notNull()
    .default("private"),
});

export type Chat = InferSelectModel<typeof chat>;

// DEPRECATED: The following schema is deprecated and will be removed in the future.
// Read the migration guide at https://chat-sdk.dev/docs/migration-guides/message-parts
export const messageDeprecated = pgTable("Message", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  chatId: uuid("chatId")
    .notNull()
    .references(() => chat.id),
  role: varchar("role").notNull(),
  content: json("content").notNull(),
  createdAt: timestamp("createdAt").notNull(),
});

export type MessageDeprecated = InferSelectModel<typeof messageDeprecated>;

export const message = pgTable("Message_v2", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  chatId: uuid("chatId")
    .notNull()
    .references(() => chat.id),
  role: varchar("role").notNull(),
  parts: json("parts").notNull(),
  attachments: json("attachments").notNull(),
  createdAt: timestamp("createdAt").notNull(),
});

export type DBMessage = InferSelectModel<typeof message>;

// DEPRECATED: The following schema is deprecated and will be removed in the future.
// Read the migration guide at https://chat-sdk.dev/docs/migration-guides/message-parts
export const voteDeprecated = pgTable(
  "Vote",
  {
    chatId: uuid("chatId")
      .notNull()
      .references(() => chat.id),
    messageId: uuid("messageId")
      .notNull()
      .references(() => messageDeprecated.id),
    isUpvoted: boolean("isUpvoted").notNull(),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.chatId, table.messageId] }),
    };
  }
);

export type VoteDeprecated = InferSelectModel<typeof voteDeprecated>;

export const vote = pgTable(
  "Vote_v2",
  {
    chatId: uuid("chatId")
      .notNull()
      .references(() => chat.id),
    messageId: uuid("messageId")
      .notNull()
      .references(() => message.id),
    isUpvoted: boolean("isUpvoted").notNull(),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.chatId, table.messageId] }),
    };
  }
);

export type Vote = InferSelectModel<typeof vote>;

export const document = pgTable(
  "Document",
  {
    id: uuid("id").notNull().defaultRandom(),
    createdAt: timestamp("createdAt").notNull(),
    title: text("title").notNull(),
    content: text("content"),
    kind: varchar("text", { enum: ["text", "code", "image", "sheet"] })
      .notNull()
      .default("text"),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.id, table.createdAt] }),
    };
  }
);

export type Document = InferSelectModel<typeof document>;

export const suggestion = pgTable(
  "Suggestion",
  {
    id: uuid("id").notNull().defaultRandom(),
    documentId: uuid("documentId").notNull(),
    documentCreatedAt: timestamp("documentCreatedAt").notNull(),
    originalText: text("originalText").notNull(),
    suggestedText: text("suggestedText").notNull(),
    description: text("description"),
    isResolved: boolean("isResolved").notNull().default(false),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id] }),
    documentRef: foreignKey({
      columns: [table.documentId, table.documentCreatedAt],
      foreignColumns: [document.id, document.createdAt],
    }),
  })
);

export type Suggestion = InferSelectModel<typeof suggestion>;

export const stream = pgTable(
  "Stream",
  {
    id: uuid("id").notNull().defaultRandom(),
    chatId: uuid("chatId").notNull(),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id] }),
    chatRef: foreignKey({
      columns: [table.chatId],
      foreignColumns: [chat.id],
    }),
  })
);

export type Stream = InferSelectModel<typeof stream>;

export const shift = pgTable("Shift", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  whattodo: text("whattodo"),
  startTime: timestamp("startTime", { withTimezone: true }),
  location: text("location"),
  skillsNeeded: text("skillsNeeded"),
  whoIsBeingHelped: text("whoIsBeingHelped"),
  laborCredits: text("laborCredits"),
  rawMessage: text("rawMessage").notNull(),
  audioUrl: text("audioUrl"),
  audioDurationMs: integer("audioDurationMs"),
  audioMimeType: text("audioMimeType"),
  audioSizeBytes: integer("audioSizeBytes"),
  createdAt: timestamp("createdAt").notNull(),
  signUpUserName: text("signUpUserName"),
  signUpAudioUrl: text("signUpAudioUrl"),
  signUpAudioDurationMs: integer("signUpAudioDurationMs"),
  signUpAudioMimeType: text("signUpAudioMimeType"),
  signUpAudioSizeBytes: integer("signUpAudioSizeBytes"),
  signUpCreatedAt: timestamp("signUpCreatedAt", { withTimezone: true }),
});

export type Shift = InferSelectModel<typeof shift>;

export const searchAudio = pgTable("SearchAudio", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  chatId: text("chatId").notNull(),
  audioUrl: text("audioUrl").notNull(),
  audioDurationMs: integer("audioDurationMs"),
  audioMimeType: text("audioMimeType"),
  audioSizeBytes: integer("audioSizeBytes"),
  transcript: text("transcript"),
  createdAt: timestamp("createdAt").notNull(),
});

export type SearchAudio = InferSelectModel<typeof searchAudio>;

/**
 * searchRental 查询留档：每次真实搜索记一行。
 * 用途：评测抽样（真实措辞分布）+ "同 chatId 连续换一个" 的不满意信号。
 */
export const searchQueryLog = pgTable("SearchQueryLog", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  chatId: text("chatId").notNull(),
  query: text("query").notNull(),
  mustNotContain: json("mustNotContain").$type<string[] | null>(),
  /** 命中的搜索阶段：P1_VECTOR / P2_CITY / P3_KEYWORD / P4_RECENT（_RELAXED 后缀=松弛）/ NO_RESULT */
  phase: text("phase").notNull(),
  listingId: uuid("listingId"),
  relaxed: boolean("relaxed").notNull().default(false),
  durationMs: integer("durationMs"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
});

export type SearchQueryLog = InferSelectModel<typeof searchQueryLog>;

/** 小红书租房帖（复制按钮上报 + 可选结构化字段） */
export const xhsRentalListing = pgTable("XhsRentalListing", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  sourceUrl: text("sourceUrl").notNull(),
  title: text("title"),
  rawText: text("rawText").notNull(),
  rent: text("rent"),
  deposit: text("deposit"),
  availableFrom: text("availableFrom"),
  leaseEndDate: text("leaseEndDate"),
  listingType: text("listingType"),
  bedrooms: text("bedrooms"),
  bathrooms: text("bathrooms"),
  roomType: text("roomType"),
  propertyName: text("propertyName"),
  locationText: text("locationText"),
  furnished: text("furnished"),
  contactMethod: text("contactMethod"),
  /** 上传到 Blob 后的公开 URL 列表，与 sourceUrl 同一帖 */
  imageUrls: json("imageUrls").$type<string[] | null>(),
  /** 论坛帖时间：优先更新于，无则发布于 */
  postedAt: timestamp("postedAt", { withTimezone: true }),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  // ── 数值过滤列（正则解析）────────────────────────────────────────────────
  /** 月租金（美元整数，100-15000 范围），供 SQL 数值过滤 */
  rentNumeric: integer("rentNumeric"),
  // ── LLM 提取的结构化字段（入库时自动填写）────────────────────────────────
  /** 卧室数整数，studio=0 */
  bedroomsNum: integer("bedroomsNum"),
  /** 标准化英文城市名，如 "San Jose"、"San Francisco" */
  city: text("city"),
  /** 是否允许宠物（true/false/null=未提及） */
  petFriendly: boolean("petFriendly"),
  /** 是否允许情侣入住 */
  couplesOk: boolean("couplesOk"),
  /** 水电是否包含在租金内 */
  utilitiesIncluded: boolean("utilitiesIncluded"),
  /** 是否有停车位 */
  parkingIncluded: boolean("parkingIncluded"),
  /** 起租门槛（月）："一年起租"→12，"只接受长租"→6；null=未提及 */
  leaseMinMonths: integer("leaseMinMonths"),
  /** 最长可住（月）：转租窗口按日期折算，"仅限一个月短租"→1；null=无上限/未知 */
  leaseMaxMonths: integer("leaseMaxMonths"),
  /**
   * SHA-256 of rawText (hex). Content-based deduplication for pending:uuid URLs.
   * Partial UNIQUE index at DB level (WHERE contentHash IS NOT NULL).
   */
  contentHash: text("contentHash"),
});

export type XhsRentalListing = InferSelectModel<typeof xhsRentalListing>;

/** 小红书求租帖：租客发布找房需求 */
export const xhsRentalWanted = pgTable("XhsRentalWanted", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  sourceUrl: text("sourceUrl").notNull(),
  title: text("title"),
  rawText: text("rawText").notNull(),
  budgetText: text("budgetText"),
  budgetMin: text("budgetMin"),
  budgetMax: text("budgetMax"),
  preferredLocations: text("preferredLocations"),
  moveInDate: text("moveInDate"),
  leaseDuration: text("leaseDuration"),
  wantedType: text("wantedType"),
  bedrooms: text("bedrooms"),
  bathrooms: text("bathrooms"),
  roomType: text("roomType"),
  furnished: text("furnished"),
  pets: text("pets"),
  occupation: text("occupation"),
  householdSize: text("householdSize"),
  gender: text("gender"),
  requirements: text("requirements"),
  contactMethod: text("contactMethod"),
  imageUrls: json("imageUrls").$type<string[] | null>(),
  aiConfidence: text("aiConfidence"),
  aiReason: text("aiReason"),
  postedAt: timestamp("postedAt", { withTimezone: true }),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  contentHash: text("contentHash"),
});

export type XhsRentalWanted = InferSelectModel<typeof xhsRentalWanted>;

/** 小红书经验/科普/其他非交易帖 */
export const xhsRentalOther = pgTable("XhsRentalOther", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  sourceUrl: text("sourceUrl").notNull(),
  rawText: text("rawText").notNull(),
  title: text("title"),
  aiReason: text("aiReason"),
  imageUrls: json("imageUrls").$type<string[] | null>(),
  postedAt: timestamp("postedAt", { withTimezone: true }),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  contentHash: text("contentHash"),
});

export type XhsRentalOther = InferSelectModel<typeof xhsRentalOther>;
