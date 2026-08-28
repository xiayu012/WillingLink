/**
 * 搜索终审（路线 C）：硬筛选 + rerank 之后、返回之前，用一次 LLM 调用
 * 拿"用户原始需求全文"逐条对读"候选房源原文"，剔除与需求实质矛盾的房源——
 * 接住结构化列永远覆盖不到的言下之意（"神仙室友继续住"→ 只出租一间，
 * 两人无法整租入住）。
 *
 * 设计约定：
 * - 只做减法：verifier 只能从已通过严格谓词的集合里剔除，绝不添加，
 *   所以评测的 PASS 语义不受影响（剔空记 VERIFIER_CUT，不算 CODE_BUG）。
 * - 宁缺毋滥（用户明确接受空结果）：有实质矛盾就剔；但只能依据用户明说的
 *   需求判断，帖子对某需求沉默不算矛盾。
 * - fail-open：LLM 不可用或输出不可解析时原样放行，搜索永不因终审挂掉。
 *   剔除决策 console.log 进 Vercel log，供人工复核。
 *
 * 实现注意：
 * - 模型必须 sonnet 级（getVerifierModel）。haiku 会臆造用户属性——把候选帖
 *   里反复出现的"无宠物"反向脑补成"用户有猫"，prompt 层面修不掉。
 * - 故意用 generateText + 自行解析，不用 generateObject：gateway 对 anthropic
 *   的结构化输出模板不稳定，会回显 "$PARAMETER_NAME"/"$parameter"/"$cuts"
 *   占位符键、把数组二次编码成字符串等，schema 校验随机失败。裸 JSON 没有
 *   这些问题。
 */
import { generateText } from "ai";
import { z } from "zod";

import { getVerifierModel } from "@/lib/ai/providers";
import type { XhsRentalSearchResultRow } from "@/lib/db/queries";

const EXCERPT_CHARS = 1200;

const cutsSchema = z.array(
  z.object({ index: z.number().int(), reason: z.string() })
);
type Cuts = z.infer<typeof cutsSchema>;

const VERIFIER_SYSTEM = `你是租房搜索的终审员。硬性条件（城市/预算/房型/租期等）已由上游筛过，你唯一的职责是读懂**言下之意**，剔除与用户需求实质矛盾的候选房源。

大胆推理隐含信息，例如：
- "和室友互不打扰"/"神仙室友，作息正常"/"我实习结束要走" → 出租的只是合租房里的一间，另一间室友继续住 → 两人/家庭想整租整套的需求无法满足。
- "限女生"对男性租客、"仅限一人"对情侣/两人同住，都是矛盾。
- 求租帖/找室友帖混进候选，对找房源的用户是矛盾。
- 租客说了要住的**整段时间**（"8.31-9.30"、"10/13到11/14"），而房源的可租窗口
  **盖不住这段**（"短租9/14-22"、"租到9/20为止"）→ 他住不满，是矛盾。
  **方向很重要，只有一头算矛盾**：房源比租客的入住日**更早**空出来完全没问题
  （房子在那儿等着他，"9月中可入住"对10/13入住的人是可以的，不许剔）；
  只有房源**结束得比租客需要的早**才是矛盾。租客没说要住到哪天就不适用这条。

工作步骤（必须严格遵守）：
1. 先把【用户需求】里明说或能可靠推出的条目抽成 requirements 清单，逐字有据；
   用户没提的属性（宠物/人数/性别等）**不存在**，不许出现在清单里。
2. 再逐条候选对照清单。每个剔除必须指明违反了清单中的哪一条——
   清单之外的任何理由都是无效的，禁止使用。

原则：
- 宁缺毋滥：候选与清单某条实质矛盾就剔，剔空也没关系。
- "帖子没提到某个需求"、"信息不全/租金不明/有风险"都不是矛盾，不剔。

**沉默 ≠ 矛盾，这条最容易违反，写理由时自己检查一遍。**
矛盾是"帖子说了 A，用户要 B，A 和 B 打架"；帖子**压根没提**这件事，是沉默，
不是矛盾。房东不写车位，可能只是没写，不代表没有——那要由用户自己去问，
不该由你替他判死刑。
线上实测的违规写法（这些 reason 全部属于**不该剔**，出现即错）：
- 「入住时间8/31，早于用户需求9月底，**虽不矛盾**，但**无车位信息**」
- 「房源为侧卧出租，且**无车位信息**」
- 「虽然有停车位，但帖子**未明确**车位是否包含或收费，存在**潜在矛盾**」
**自检规则**：写完 reason 回头看一眼，只要里面出现"虽不矛盾""潜在矛盾"
"未明确""没写""无…信息""信息不全""可能"这类词，说明你手里根本没有实锤，
**就不要剔这一条**。剔除的理由必须能指着帖子里的**一句实际存在的话**说
"它写了这个，跟用户要的那个直接打架"。

只输出一个 JSON 对象，不要任何其他文字或代码围栏，格式：
{"requirements": ["…"], "cuts": [{"index": 候选序号, "requirement": "被违反的清单条目", "reason": "帖子里的什么证据与之矛盾"}]}
没有要剔的就输出 {"requirements": […], "cuts": []}
字符串值里引用原文一律用「」标注，绝不能出现未转义的英文双引号。`;

export type VerifierResult = {
  kept: XhsRentalSearchResultRow[];
  cut: { id: string; title: string | null; reason: string }[];
};

const WHITESPACE_RE = /\s/;
const CODE_FENCE_RE = /```(?:json)?/g;
const JSON_OBJECT_RE = /\{[\s\S]*\}/;

/**
 * 修复字符串值内未转义的英文双引号（模型引用帖子原文时的高频错误：
 * "reason": "帖子明确要求"一年起租"，…"）。启发式：字符串里的 `"` 后面
 * （跳过空白）不是 , } ] : 之一就当作内容引号转义掉。
 */
function repairInnerQuotes(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inStr) {
      if (ch === '"') {
        inStr = true;
      }
      out += ch;
    } else if (ch === "\\") {
      out += ch + (s[i + 1] ?? "");
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < s.length && WHITESPACE_RE.test(s[j])) {
        j++;
      }
      if (j >= s.length || [",", "}", "]", ":"].includes(s[j])) {
        inStr = false;
        out += ch;
      } else {
        out += '\\"';
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/** 从模型输出里取出最外层 JSON 对象并校验出 cuts；解析失败返回 null。 */
function parseCuts(raw: string): Cuts | null {
  const text = raw.replace(CODE_FENCE_RE, ""); // 偶发代码围栏，剥掉
  const m = text.match(JSON_OBJECT_RE);
  if (!m) {
    return null;
  }
  for (const candidate of [m[0], repairInnerQuotes(m[0])]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      const ok = cutsSchema.safeParse((parsed as { cuts?: unknown }).cuts);
      if (ok.success) {
        return ok.data;
      }
    } catch {
      // 修复后再试一轮；两轮都失败返回 null → fail-open
    }
  }
  return null;
}

/**
 * 「房源可入住日**早于**租客入住日」——终审员反复拿这个当剔除理由，而它根本
 * 不是矛盾：房子早就空着，租客晚点搬进去当然可以。
 *
 * **为什么用代码挡而不是继续写提示词**：这条规则提示词里已经写了两遍（见
 * VERIFIER_SYSTEM 里的方向说明），实测仍然每轮违反 4-6 次；把"无车位信息"
 * 那个说法堵掉之后，它立刻改用这个说法继续剔同一批房源。措辞能无限换，
 * 按下葫芦浮起瓢，只有代码挡得住。
 *
 * **为什么挡得心安理得**：能走到终审的房源，早就通过了硬筛选里的
 * `checkMoveInFeasibility`（可入住日 ≤ 租客入住日）。也就是说"入住日可行性"
 * 这件事**上游已经用结构化数据判过了**，终审在这里做的是重判，而且判错。
 * 终审的职责是读言下之意，不是复核上游已经算准的东西。
 *
 * **不能误伤的那一类**：租期"结束得太早"（"短租9/14-22"盖不住8.31-9.30）
 * 上游查不了，必须留给终审。所以这里只挡"开始得早"，凡是提到结束/到期/
 * 租期盖不住的一律放行。
 */
const MOVE_IN_EARLY_RE =
  /(?:入住|可入住|起租|available)[^。；;]{0,24}(?:早于|提前于|早|之前)|(?:早于|提前)[^。；;]{0,12}(?:用户|租客)?[^。；;]{0,12}入住/;
const REAL_WINDOW_CONFLICT_RE =
  /结束|到期|租期(?:到|至|结束)|住不满|盖不住|无法满足[^。；;]{0,12}(?:整段|租期)|短租[^。；;]{0,12}(?:到|至)/;

function isRelitigatingMoveIn(reason: string): boolean {
  if (REAL_WINDOW_CONFLICT_RE.test(reason)) {
    return false; // 说的是"结束得太早"，那是真矛盾，放行
  }
  return MOVE_IN_EARLY_RE.test(reason);
}

function applyVerdict(
  listings: XhsRentalSearchResultRow[],
  cuts: Cuts
): VerifierResult {
  const reasonByIndex = new Map(
    cuts
      .filter((c) => c.index >= 0 && c.index < listings.length)
      .filter((c) => {
        if (isRelitigatingMoveIn(c.reason)) {
          console.log(
            "[verifyListings] 驳回剔除(重判入住日，上游已判过):",
            c.reason.slice(0, 120)
          );
          return false;
        }
        return true;
      })
      .map((c) => [c.index, c.reason])
  );
  const kept: XhsRentalSearchResultRow[] = [];
  const cut: VerifierResult["cut"] = [];
  listings.forEach((l, i) => {
    const reason = reasonByIndex.get(i);
    if (reason == null) {
      kept.push(l);
    } else {
      cut.push({ id: l.id, title: l.title, reason });
    }
  });
  return { kept, cut };
}

/** 单次调用的候选上限——超过就分块并行，避免长输入拖慢首屏。 */
const VERIFY_CHUNK_SIZE = 8;

/**
 * 终审一次检索备好的全部候选（top-K，目前 24 条）。整批一起审而不是每批一次，
 * 是为了让"继续/换一批"能直接从缓存瞬间出下一批；超过一块就**并行**发多次
 * 调用，总 token 不变而延迟只等最慢的一块（串行 24 条要 14s，并行约 5s）。
 * 任何失败都 fail-open 原样放行。
 */
export async function verifyListingsAgainstQuery(
  query: string,
  listings: XhsRentalSearchResultRow[]
): Promise<VerifierResult> {
  if (listings.length <= VERIFY_CHUNK_SIZE) {
    return await verifyChunk(query, listings);
  }
  const chunks: XhsRentalSearchResultRow[][] = [];
  for (let i = 0; i < listings.length; i += VERIFY_CHUNK_SIZE) {
    chunks.push(listings.slice(i, i + VERIFY_CHUNK_SIZE));
  }
  const results = await Promise.all(chunks.map((c) => verifyChunk(query, c)));
  // 分块顺序即原顺序，flatMap 后相关度排序保持不变。
  return {
    kept: results.flatMap((r) => r.kept),
    cut: results.flatMap((r) => r.cut),
  };
}

async function verifyChunk(
  query: string,
  listings: XhsRentalSearchResultRow[]
): Promise<VerifierResult> {
  if (listings.length === 0) {
    return { kept: listings, cut: [] };
  }
  try {
    const docs = listings
      .map(
        (l, i) =>
          `【${i}】${l.title ?? "(无标题)"}\n${l.rawText.slice(0, EXCERPT_CHARS)}`
      )
      .join("\n\n");
    const { text, finishReason } = await generateText({
      model: getVerifierModel(),
      system: VERIFIER_SYSTEM,
      prompt: `【用户需求】\n${query}\n\n【候选房源】\n${docs}`,
      temperature: 0,
    });
    const cuts = parseCuts(text);
    if (cuts == null) {
      console.error(
        "[verifyListings] fail-open: unparseable:",
        finishReason,
        text.slice(0, 400).replace(/\n/g, "\\n")
      );
      return { kept: listings, cut: [] };
    }
    return applyVerdict(listings, cuts);
  } catch (error) {
    // 不能把 error 对象直接交给 console.error：AI SDK 的错误对象曾让
    // util.inspect 自身抛 TypeError，异常从 catch 里逃逸、击穿 fail-open。
    const msg =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    console.error("[verifyListings] fail-open:", msg);
    return { kept: listings, cut: [] };
  }
}
