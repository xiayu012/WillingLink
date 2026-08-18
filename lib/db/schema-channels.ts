import type { InferSelectModel } from "drizzle-orm";
import { pgTable, timestamp, uuid, varchar, index, unique } from "drizzle-orm/pg-core";
import { user } from "./schema";

/**
 * 外部身份 → 内部 user 的映射。
 *
 * **单独放一个文件，且暂时不从 lib/db/schema.ts 导出**，是有意的：drizzle 的
 * `db.select().from(x)` 会按 schema 里定义的列去查，库里没有这张表/这些列时
 * 直接报错。把它放在这里，跑过建表 SQL 之前，现有聊天一行代码都不受影响。
 *
 * 上线顺序：
 * 1. 在 Neon 控制台执行 `lib/db/migrations/manual/channel-identity.sql`
 *    （与 XhsRentalListing 同样的"一次性建表"做法，不进 drizzle journal）
 * 2. 确认表在了，再把 adapter 的 CHANNEL_ADAPTERS_ENABLED 打开
 * 3. 以后要给 Message_v2 加 channel / externalMessageId 两列时，同一个 SQL
 *    文件里已经写好了 ALTER TABLE，跑完再把列加进 schema.ts 的 message 定义
 */
export const channelIdentity = pgTable(
  "ChannelIdentity",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    /** web / xhs / sms / wecom，见 lib/chat/types.ts 的 CHANNELS */
    channel: varchar("channel", { length: 32 }).notNull(),
    /** 该渠道里这个人的唯一 id：xhs userId、手机号、wecom external_userid */
    externalUserId: varchar("externalUserId", { length: 128 }).notNull(),
    /** 同渠道多账号时区分是哪个客服号收到的；现在可以全是 null */
    accountId: varchar("accountId", { length: 128 }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => ({
    // 同一个渠道 + 同一个外部 id 只能指向一个内部 user
    channelExternalUnique: unique("ChannelIdentity_channel_external_unique").on(
      table.channel,
      table.externalUserId
    ),
    userIdx: index("ChannelIdentity_userId_idx").on(table.userId),
  })
);

export type ChannelIdentity = InferSelectModel<typeof channelIdentity>;
