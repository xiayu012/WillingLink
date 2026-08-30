import "server-only";

/**
 * 进程内会话历史。**临时方案，等状态库落地就删掉。**
 *
 * 明确的局限（不要指望它）：
 * - serverless 上每个实例一份，扩容/冷启动就丢；同一个人两条消息可能落到不同实例
 * - 不持久化，重启即空
 * - 只存对话轮次，**不存住户档案**（作息、偏好、未闭环事项）——
 *   而准则真正要的是后者：「有人投诉噪音时系统已经知道谁在睡」靠的是档案不是历史
 *
 * 所以它只够用来验证「短信能通、大脑能答」，不足以支撑真实运营。
 */

export type Turn = { role: "user" | "assistant"; content: string };

type Session = { turns: Turn[]; updatedAt: number };

const sessions = new Map<string, Session>();

const TTL_MS = 30 * 60 * 1000; // 30 分钟
const MAX_TURNS = 20; // 只留最近 10 轮问答

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, s] of sessions) {
    if (s.updatedAt < cutoff) {
      sessions.delete(key);
    }
  }
}

export function getTurns(key: string): Turn[] {
  sweep();
  return sessions.get(key)?.turns ?? [];
}

export function appendTurn(key: string, turn: Turn): void {
  sweep();
  const existing = sessions.get(key) ?? { turns: [], updatedAt: Date.now() };
  existing.turns.push(turn);
  if (existing.turns.length > MAX_TURNS) {
    existing.turns = existing.turns.slice(-MAX_TURNS);
  }
  existing.updatedAt = Date.now();
  sessions.set(key, existing);
}

export function clearSession(key: string): void {
  sessions.delete(key);
}
