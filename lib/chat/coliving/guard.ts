import "server-only";

/**
 * 防止本地测试脚本把伪造的消息写进真实住户的对话里。
 *
 * ## 出过的事故（2026-09-02）
 *
 * 我为了测「敏感话题它敢不敢接」，在本地脚本里伪造了一条入站消息
 * 「这个月房租我可能交不上，我上周被裁了」。本地脚本连的是**同一个生产库**，
 * 于是那句话变成了房东的真实对话历史。用户随后真的发短信过来时，
 * AI 带着这段编造的前情跟他说话——**等于我凭空给用户安了一个人设。**
 *
 * ## 所以这里是硬拦截，不是提醒
 *
 * 服务器进程（Vercel / next dev）随便写。
 * **本地脚本默认一个字都写不进去**，要写必须同时满足两条：
 *
 *   1. 显式设 `COLIVING_LOCAL_WRITE=1`
 *   2. 目标 household 是测试屋（`household.is_test = true`）
 *
 * 第二条是关键：**光有环境变量不够**。真实住户住的那栋房子，
 * 本地进程永远写不进去，不管谁设了什么变量。
 *
 * 要本地跑对话，先 `pnpm coliving:db --test-house` 开一栋测试屋。
 */

/** 跑在服务器运行时里（Vercel 函数 / next dev），不是本地一次性脚本 */
function isServerRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.NEXT_RUNTIME);
}

export class LocalWriteBlocked extends Error {
  constructor(reason: string) {
    super(
      `[coliving] 本地进程不许写真实数据：${reason}\n` +
        "  要在本地跑对话，先开一栋测试屋：\n" +
        "    pnpm coliving:db --test-house\n" +
        "  然后带上 COLIVING_LOCAL_WRITE=1 再跑。\n" +
        "  （这道闸是因为我曾把伪造的消息写进用户真实对话历史，见 guard.ts）"
    );
    this.name = "LocalWriteBlocked";
  }
}

/**
 * 任何会往世界模型里写东西的入口都要先过这里。
 * `isTestHousehold` 由调用方从 household 行上取。
 */
export function assertCanWrite(args: {
  isTestHousehold: boolean;
  what: string;
}): void {
  if (isServerRuntime()) {
    return;
  }
  if (process.env.COLIVING_LOCAL_WRITE !== "1") {
    throw new LocalWriteBlocked(
      `${args.what}（没有 COLIVING_LOCAL_WRITE=1）`
    );
  }
  if (!args.isTestHousehold) {
    throw new LocalWriteBlocked(
      `${args.what}（这栋不是测试屋，里面可能住着真人）`
    );
  }
}
