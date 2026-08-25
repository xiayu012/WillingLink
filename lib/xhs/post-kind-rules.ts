/**
 * 帖子分类的**正则快路径**。
 *
 * 单独一个文件、**不 import 任何东西**：这样回归门禁能直接引它跑几十个字符串
 * 判断，不用把模型层、`server-only`、数据库连接一起拖进来。`post-kind.ts` 先调
 * 这里，判不出来才落到模型。
 */

export type PostKind =
  /** 本人正在求租 → 给 ta 推房源 */
  | "seeker"
  /** 本人有房出租 → 给 ta 推求租的人 */
  | "lister"
  /** 找室友（本人已定/将定房子，缺人一起住）→ 给 ta 推同样找室友的人 */
  | "roommate"
  /** 看房体验、公寓测评、避雷 → 不评论 */
  | "review"
  /** 提问、求建议、科普攻略 → 不评论 */
  | "advice"
  /** 跟租房无关 → 不评论 */
  | "other";

export type PostKindResult = {
  kind: PostKind;
  confidence: number;
  reason: string;
  source: "rule" | "ai";
};

/**
 * 只有这三类才起草评论。
 *
 * review/advice/other 一律跳过——**宁可少评一条，不要评错一条**：评错了是当着
 * 全平台的面答非所问，比不评论难看得多，而且白烧一整轮带搜索的 agent。
 */
const ACTIONABLE: ReadonlySet<PostKind> = new Set([
  "seeker",
  "lister",
  "roommate",
]);

export function shouldDraftComment(kind: PostKind): boolean {
  return ACTIONABLE.has(kind);
}

const REVIEW_PATTERNS = [
  /看房(体验|感受|记录|vlog)/u,
  /(公寓|apartment)\s*(测评|评测|review)/iu,
  /实地\s*tour/iu,
  /踩坑|避雷|吐槽/u,
  /租房(经验|攻略|心得|总结)/u,
] as const;

const ROOMMATE_PATTERNS = [
  // 中间要允许插字：真实帖子写的是「找**一位合拍女生**室友」「招**一个**室友」，
  // 死板的 /找室友/ 一条都命中不了（门禁里那条 case 就是这么发现的）。
  // 限制在同一句内（不跨句号/问号/换行），避免跨句误连。
  /[找招募求寻][^。！？!?\n]{0,12}室友/u,
  /[找招募求寻][^。！？!?\n]{0,12}roommate/iu,
  /一起租|合租搭子|凑室友/u,
] as const;

const SEEKER_PATTERNS = [/求租/u, /找房/u, /想租/u, /求转租/u] as const;
const LISTER_PATTERNS = [/出租/u, /招租/u, /转租/u] as const;

function countHits(text: string, patterns: readonly RegExp[]): number {
  return patterns.filter((re) => re.test(text)).length;
}

/**
 * 判不出来就返回 null，交给模型。
 *
 * **只在证据非常硬时下结论**，因为判错的代价不对称：求租帖误判成体验帖 →
 * 少评一条（可惜）；体验帖误判成求租帖 → 评论区答非所问（丢人）。
 */
export function classifyPostKindByRule(rawText: string): PostKindResult | null {
  const text = rawText.trim();
  if (text.length === 0) {
    return null;
  }

  const review = countHits(text, REVIEW_PATTERNS);
  const roommate = countHits(text, ROOMMATE_PATTERNS);
  const seeker = countHits(text, SEEKER_PATTERNS);
  const lister = countHits(text, LISTER_PATTERNS);

  // 体验帖：有体验词、且没有任何交易意图词，才敢直接判定
  if (review > 0 && roommate === 0 && seeker === 0 && lister === 0) {
    return {
      kind: "review",
      confidence: 0.9,
      reason: "命中看房体验/测评用语，且无求租招租找室友信号",
      source: "rule",
    };
  }

  // 找室友：**只有在没有求租信号时**才敢直接判。
  //
  // 放宽「找…室友」允许插字之后踩过一次：求租帖里写「求租一个房间…希望室友
  // 不抽烟」，被正则抢走判成 roommate，而模型本来判对是 seeker。求租帖顺带写
  // 室友要求太常见了，所以这里让路——有 seeker 信号就交给模型，别抢。
  // 体验词同时出现时同理。
  if (roommate > 0 && review === 0 && seeker === 0) {
    return {
      kind: "roommate",
      confidence: 0.85,
      reason: "命中找室友用语，且无求租/看房体验信号",
      source: "rule",
    };
  }

  return null;
}
