import "server-only";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createGuestUser } from "@/lib/db/queries";
import { channelIdentity } from "@/lib/db/schema-channels";
import type { ExternalIdentity } from "./types";

/**
 * 外部身份 → 内部 user。
 *
 * 一个人可能同时是 xhs:847392、sms:+1408...、web:<uuid>，这些都指向同一个内部
 * user，于是他在哪个渠道说话都进同一条 conversation。
 *
 * 现在的策略最简单：**没见过的外部身份就建一个 guest user 绑上去**。以后要做
 * "小红书用户后来提供了手机号 → 合并到同一个内部 user"，就是把两行
 * ChannelIdentity 的 userId 改成同一个（SQL 文件里有说明）；合并策略、冲突
 * 处理等真有第二个渠道再定，现在不预设。
 */

// 单独建连接：lib/db/queries.ts 的 db 是模块私有的，而这张表还没并进 schema.ts
// （原因见 schema-channels.ts 顶部注释）。等表稳定了就把这两处合成一处。
// biome-ignore lint: Forbidden non-null assertion.
const client = postgres(process.env.POSTGRES_URL!);
const db = drizzle(client);

export class ChannelTableMissingError extends Error {
  constructor() {
    super(
      "ChannelIdentity 表不存在：先在 Neon 执行 lib/db/migrations/manual/channel-identity.sql"
    );
    this.name = "ChannelTableMissingError";
  }
}

function isMissingTable(error: unknown): boolean {
  // postgres.js 的 undefined_table
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "42P01"
  );
}

/** 查已有映射；表还没建时抛 ChannelTableMissingError，adapter 会翻译成明确的报错 */
export async function findUserIdByIdentity(
  identity: ExternalIdentity
): Promise<string | null> {
  try {
    const rows = await db
      .select({ userId: channelIdentity.userId, displayName: channelIdentity.displayName })
      .from(channelIdentity)
      .where(
        and(
          eq(channelIdentity.channel, identity.channel),
          eq(channelIdentity.externalUserId, identity.externalUserId)
        )
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    // 昵称会改（小红书改名很常见），看到新的就更新；没拿到就别覆盖成空
    if (identity.displayName && identity.displayName !== row.displayName) {
      await db
        .update(channelIdentity)
        .set({ displayName: identity.displayName })
        .where(
          and(
            eq(channelIdentity.channel, identity.channel),
            eq(channelIdentity.externalUserId, identity.externalUserId)
          )
        );
    }
    return row.userId;
  } catch (error) {
    if (isMissingTable(error)) {
      throw new ChannelTableMissingError();
    }
    throw error;
  }
}

/** 查不到就建一个 guest user 并绑定，返回内部 userId */
export async function resolveInternalUserId(
  identity: ExternalIdentity
): Promise<string> {
  const existing = await findUserIdByIdentity(identity);
  if (existing) {
    return existing;
  }

  const [guest] = await createGuestUser();
  await db.insert(channelIdentity).values({
    userId: guest.id,
    channel: identity.channel,
    externalUserId: identity.externalUserId,
    accountId: identity.accountId ?? null,
    displayName: identity.displayName ?? null,
  });

  console.log(
    "[channel-identity] 新身份已绑定",
    JSON.stringify({
      channel: identity.channel,
      externalUserId: identity.externalUserId,
      displayName: identity.displayName ?? null,
      userId: guest.id,
    })
  );

  return guest.id;
}

/**
 * 把一个外部身份挂到已有的内部 user 上（身份合并用）。
 * 例如小红书用户后来发来手机号，确认是同一个人：
 *   linkIdentity({ channel: "sms", externalUserId: "+1408..." }, xhsUserId)
 */
export async function linkIdentity(
  identity: ExternalIdentity,
  userId: string
): Promise<void> {
  await db
    .insert(channelIdentity)
    .values({
      userId,
      channel: identity.channel,
      externalUserId: identity.externalUserId,
      accountId: identity.accountId ?? null,
      displayName: identity.displayName ?? null,
    })
    .onConflictDoNothing();
}
