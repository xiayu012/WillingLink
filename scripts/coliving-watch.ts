/**
 * 监听本地 csv，房东号码一保存就送进线上数据库。
 *
 *   pnpm coliving:watch              # 守着文件，保存即发
 *   pnpm coliving:watch --once       # 只跑一次就退出
 *   pnpm coliving:watch --local      # 打本地 dev server 而不是线上
 *
 * 默认文件：`C:\Users\78\Desktop\user_phone_number.csv`
 * 换路径：`COLIVING_WATCH_FILE=D:\somewhere\x.csv`
 *
 * **这是整个系统的起点**：你先认识房东、先拿到他的号码，写进这个文件。
 * 剩下的住户号码由 AI 在跟房东的对话里问出来，不需要你再填任何东西。
 *
 * 文件格式随便：一行一个号码，或者带表头的 csv，或者逗号分隔——
 * 脚本只从整个文本里把像手机号的东西捞出来。**别让人为了喂数据去学格式。**
 */

import { readFileSync, watch } from "node:fs";
import { config } from "dotenv";

config({ path: ".env.local" });

const FILE =
  process.env.COLIVING_WATCH_FILE?.trim() ||
  "C:\\Users\\78\\Desktop\\user_phone_number.csv";

const TARGET = process.argv.includes("--local")
  ? "http://localhost:3000/api/coliving/enroll"
  : "https://www.willinglink.com/api/coliving/enroll";

/** 从任意文本里捞北美手机号。宽进严出，格式不挑。 */
function extractPhones(text: string): string[] {
  const out = new Set<string>();
  const re = /(\+?1[\s\-.]?)?\(?(\d{3})\)?[\s\-.]?(\d{3})[\s\-.]?(\d{4})(?!\d)/g;
  let m = re.exec(text);
  while (m !== null) {
    out.add(`+1${m[2]}${m[3]}${m[4]}`);
    m = re.exec(text);
  }
  return [...out];
}

/** 已经送过的不再重复送，避免编辑器一次保存触发多次 */
const sent = new Set<string>();

async function push(): Promise<void> {
  let text: string;
  try {
    text = readFileSync(FILE, "utf8");
  } catch {
    console.log(`读不到 ${FILE}`);
    return;
  }

  const phones = extractPhones(text).filter((p) => !sent.has(p));
  if (phones.length === 0) {
    return;
  }

  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.log("⚠️ .env.local 里没有 CRON_SECRET，线上会 401");
  }
  const res = await fetch(TARGET, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({ phones }),
    // **不跟随重定向**：跟了就会把 POST 变成打 /api/auth/guest，
    // 拿回一个莫名其妙的 405，看不出真正原因（踩过一次）。
    redirect: "manual",
  }).catch((e) => {
    console.log("发送失败：", e instanceof Error ? e.message : e);
    return null;
  });
  if (!res) {
    return;
  }

  if (res.status >= 300 && res.status < 400) {
    console.log(
      `✗ 被重定向到 ${res.headers.get("location") ?? "?"}\n` +
        "  这条路由被中间件当成需要登录的页面拦了。" +
        "proxy.ts 里要放行 /api/coliving/。"
    );
    return;
  }

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    results?: Array<{ phone: string; created: boolean; error?: string }>;
    error?: string;
  };
  if (!(res.ok && body.ok)) {
    console.log(`HTTP ${res.status}`, body.error ?? "");
    return;
  }
  for (const r of body.results ?? []) {
    sent.add(r.phone);
    console.log(
      r.error
        ? `  ✗ ${r.phone}  ${r.error}`
        : r.created
          ? `  ✓ ${r.phone}  已入库，AI 正在给他发第一条消息`
          : `  · ${r.phone}  本来就在库里，没重复打扰`
    );
  }
}

async function main() {
  console.log(`监听 ${FILE}`);
  console.log(`目标   ${TARGET}\n`);
  await push();

  if (process.argv.includes("--once")) {
    process.exit(0);
  }

  // 编辑器保存常常触发多次事件，压一下抖动
  let timer: NodeJS.Timeout | null = null;
  watch(FILE, () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      console.log(`[${new Date().toLocaleTimeString()}] 文件变了`);
      void push();
    }, 500);
  });
  console.log("守着呢。保存那个文件就会自动发。Ctrl+C 退出。");
}

main().catch((e) => {
  console.log("失败：", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
