import "server-only";

import { getChatsByUserId, saveChat } from "@/lib/db/queries";
import { generateUUID } from "@/lib/utils";

/**
 * 内部 user → 该用哪条 conversation。
 *
 * **跨渠道连续上下文的关键就是这里**：不管消息从哪个渠道进来，同一个内部 user
 * 都落到同一个 chatId，于是 Chat Engine 读到的是一整串连续历史。
 *
 * 现在的策略：**用这个人最近的一条会话，没有就新建**。够跑通，也符合"一个人
 * 一条主线对话"的直觉。以后要做"按话题分会话""客服手动开新会话"，就在这里加
 * 一个 resolveStrategy，adapter 那层完全不用动。
 */
export async function resolveChatIdForUser({
  userId,
  title = "New chat",
}: {
  userId: string;
  title?: string;
}): Promise<string> {
  const recent = await getChatsByUserId({
    id: userId,
    limit: 1,
    startingAfter: null,
    endingBefore: null,
  });

  const existing = recent.chats?.[0];
  if (existing) {
    return existing.id;
  }

  const chatId = generateUUID();
  await saveChat({
    id: chatId,
    userId,
    title,
    // 渠道进来的会话默认私有；网页端只有本人登录后能看到
    visibility: "private",
  });
  return chatId;
}
