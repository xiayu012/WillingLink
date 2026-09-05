/**
 * 评测号码的「槽位号 → 本次运行独有的真号」映射。
 *
 * ## 为什么必须每次跑都换号（真实事故，2026-09-05 发现）
 *
 * `coliving.person_contact` 上 `(kind, value)` 是**全局**唯一索引，
 * 而 `resolveSender` 是 `limit 1` 且**没有 order by**。语料场景里写死号码，
 * 反复跑批就会让同一个号积累出多栋 household 的 membership——
 * 之后每次跑，认到哪一栋是**任意的**。
 *
 * 实测：`+15550003001` 挂了 2 栋、`+15570001001` 挂了 4 栋。
 * 后果是 `addresident-greeting` 那条场景认进了几小时前那栋屋子，
 * 里面住客早就加过了，模型于是回「这两个号码先前收到了」、
 * 理所当然没调 `addResident`——**看起来像大脑退化了，其实是评测自己脏了**。
 *
 * 这会**静默废掉「语料只增不减、每次全量重跑」这个前提**：
 * 第一次跑是干净的，从第二次开始测的都是被上一次污染过的状态。
 *
 * 所以：场景 JSON 里写**槽位号**（稳定、可提交、可读），跑的时候一律换成
 * 本次运行独有的真号。快照重放走的是同一套逻辑（见 `snapshot.ts`）。
 */

/** 一次运行内独有的号码前缀，够短以便凑成合法的 E.164 长度 */
function runTag(): string {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
}

/**
 * 给一组槽位号生成本次运行独有的真号。
 *
 * 槽位号的**后两位**保留下来，肉眼能对上是同一个人
 * （`+15550003001` → `+1555<随机6位>01`）。
 */
export function makeLivePhones(slots: string[]): Record<string, string> {
  const tag = runTag();
  const map: Record<string, string> = {};
  for (const slot of slots) {
    map[slot] = `+1555${tag}${slot.slice(-2)}`;
  }
  return map;
}

/**
 * 把场景里出现的槽位号**全部**收集出来——`people` 里声明的，
 * 加上只出现在消息正文里的。
 *
 * 后者不能漏：`addresident-greeting` 那条场景要加的两个人，号码只写在
 * 房东那句话里（"一个电话是 155…"），没在 `people` 里声明过。
 * 漏掉它们，正文里就会留着上次跑批的旧号，加进来的是个陈年测试人格。
 *
 * 认号规则跟语料约定一致：`555` 开头的 10 位号（前面可有 `+1`）。
 */
export function collectSlotPhones(args: {
  people?: Array<{ phone: string }>;
  turns: Array<{ from: string; text: string }>;
}): string[] {
  const slots = new Set<string>();
  for (const p of args.people ?? []) slots.add(p.phone);
  for (const t of args.turns) {
    slots.add(t.from);
    for (const m of t.text.matchAll(/\+?1?(555\d{7})/g)) {
      slots.add(`+1${m[1]}`);
    }
  }
  return [...slots];
}

/**
 * 把正文里出现的槽位号换成真号。
 *
 * **正文也必须换**——`addresident-greeting` 那条场景的号码就写在消息里
 * （「一个电话是 15550003002」），只换 `from` 不换正文的话，模型会去加一个
 * 上一次跑批留下的旧号，等于没测。
 *
 * 覆盖两种写法：带 `+1` 的 E.164，和裁掉 `+1` 的十位数字。
 */
export function rewritePhonesInText(
  text: string,
  map: Record<string, string>
): string {
  let out = text;
  for (const [slot, live] of Object.entries(map)) {
    out = out.split(slot).join(live);
    // 正文里常见的是不带 +1 的十位写法
    const bareSlot = slot.replace(/^\+1/, "");
    const bareLive = live.replace(/^\+1/, "");
    if (bareSlot !== slot) out = out.split(bareSlot).join(bareLive);
  }
  return out;
}
