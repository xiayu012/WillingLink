import { generateObject } from "ai";
import { z } from "zod";

import { getTitleModel } from "@/lib/ai/providers";

// "other" is a defensive escape hatch, reachable only via the LLM path.
// Step-1 (classifyPost) is the primary non-transaction gate; but its fast path
// is keyword-driven and "other" is a diffuse negative class that keywords
// cannot reliably identify positively. So we let the full-text LLM here say
// "other" too, giving the pipeline a second chance to keep 攻略/科普 posts out
// of the rental library instead of force-bucketing them into seeker/lister.
export type RentalPostIntent = "seeker" | "lister" | "other";

export type RentalPostClassification = {
  intent: RentalPostIntent;
  confidence: number;
  reason: string;
  source: "rule" | "ai";
};

const classificationSchema = z.object({
  intent: z.enum(["seeker", "lister", "other"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

const SEEKER_PATTERNS = [
  /求租/u,
  /找房/u,
  /求合租/u,
  /想租/u,
  /寻找房源/u,
  /looking\s+for\s+(?:a\s+)?(?:room|apartment|place|housing)/iu,
  /seeking\s+(?:a\s+)?(?:room|apartment|place|housing)/iu,
  /need\s+(?:a\s+)?(?:room|apartment|place)/iu,
] as const;

const LISTER_PATTERNS = [
  /出租/u,
  /转租/u,
  /招租/u,
  /有房/u,
  /次卧出租/u,
  /主卧出租/u,
  /房间出租/u,
  /整套出租/u,
  /sublease\s+available/iu,
  /room\s+available/iu,
  /for\s+rent/iu,
] as const;

function ruleBasedClassify(rawText: string): RentalPostClassification | null {
  const text = rawText.trim();
  if (text.length === 0) {
    return null;
  }

  let seekerScore = 0;
  let listerScore = 0;

  for (const pattern of SEEKER_PATTERNS) {
    if (pattern.test(text)) {
      seekerScore += 1;
    }
  }
  for (const pattern of LISTER_PATTERNS) {
    if (pattern.test(text)) {
      listerScore += 1;
    }
  }

  if (seekerScore > 0 && listerScore === 0) {
    return {
      intent: "seeker",
      confidence: Math.min(0.95, 0.7 + seekerScore * 0.08),
      reason: "规则命中求租/找房关键词",
      source: "rule",
    };
  }

  if (listerScore > 0 && seekerScore === 0) {
    return {
      intent: "lister",
      confidence: Math.min(0.95, 0.7 + listerScore * 0.08),
      reason: "规则命中出租/招租关键词",
      source: "rule",
    };
  }

  return null;
}

/**
 * @param options.model 覆盖分类模型。入库路径保持默认（getTitleModel）不动；
 *   油猴的 post-intent 只是决定"这条帖子要不要走后面那套贵的评论生成"，用最便宜
 *   的模型足够，所以那条路由传 getFeedTitleModel()。
 */
export async function classifyRentalPostIntent(
  rawText: string,
  options?: { model?: Parameters<typeof generateObject>[0]["model"] }
): Promise<RentalPostClassification> {
  const ruleResult = ruleBasedClassify(rawText);
  if (ruleResult && ruleResult.confidence >= 0.82) {
    return ruleResult;
  }

  try {
    const { object } = await generateObject({
      model: options?.model ?? getTitleModel(),
      schema: classificationSchema,
      system: `你是美国湾区租房帖分类器。判断发帖人是「求租者」「招租者」还是「非交易帖」。

seeker（求租者）：
- 自己在找房、求租、找合租位、找室友加入
- 描述预算、期望入住时间、意向区域、户型偏好
- 没有现成房源可出租

lister（招租者）：
- 房东、转租者、已有租约并出租房间
- 描述现有房源、租金、可入住时间、房屋条件
- 招租或转租

other（非交易帖）：
- 经验分享、攻略、科普、避坑、生活记录等，既不求租也不招租
- 只有当明显不是求租/招租时才用 other；拿不准时优先 seeker/lister

注意：「找室友」需结合上下文。若已有房并出租床位→lister；若找房并求合租→seeker。

只输出 JSON。`,
      prompt: rawText.slice(0, 4000),
    });

    return {
      intent: object.intent,
      confidence: object.confidence,
      reason: object.reason,
      source: "ai",
    };
  } catch (error) {
    if (ruleResult) {
      return ruleResult;
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      intent: "lister",
      confidence: 0.45,
      reason: `AI 分类失败，默认按招租帖处理: ${message}`,
      source: "rule",
    };
  }
}
