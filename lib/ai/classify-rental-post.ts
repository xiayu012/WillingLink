import { generateObject } from "ai";
import { z } from "zod";

import { getArkModel } from "@/lib/ai/ark";

/**
 * 三分类：
 *   - seeker : 求租者，正在找房/找室友
 *   - lister : 招租者，房东/二房东有房源要出租
 *   - other  : 非交易帖（经验分享/攻略/科普/生活记录等），不入租房库
 */
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
 * 只有当规则命中非常明确（单侧关键词命中、无竞争信号）时才走硬判断快速路径，
 * 且仅限 seeker/lister 这两个关键词库覆盖较好的类别——"other" 本质是一个
 * 弥散的负类（攻略/科普/生活记录等），关键词很难可靠地正向识别，
 * 所以不给 other 设硬判断快速路径：规则不确定的一律交给 LLM 阅读全文软判断。
 */
export async function classifyRentalPostIntent(
  rawText: string
): Promise<RentalPostClassification> {
  const ruleResult = ruleBasedClassify(rawText);
  if (ruleResult && ruleResult.confidence >= 0.82) {
    return ruleResult;
  }

  try {
    const { object } = await generateObject({
      model: getArkModel(),
      schema: classificationSchema,
      temperature: 0,
      system: `你是美国湾区租房帖分类器。阅读全文，判断这篇帖子属于「求租」「招租」还是「非交易帖」。

seeker（求租者）：
- 自己在找房、求租、找合租位、找室友加入
- 描述预算、期望入住时间、意向区域、户型偏好
- 没有现成房源可出租

lister（招租者）：
- 房东、转租者、已有租约并出租房间
- 描述现有房源、租金、可入住时间、房屋条件
- 招租或转租

other（非交易帖，不涉及具体找房/出租请求）：
- 经验分享、攻略、科普、总结、政策解读、注意事项、吐槽、生活记录
- 只是讨论湾区租房话题（房价行情、买房投资等），但没有具体的出租或求租请求

判断原则：
- 只有明确表达"我有房/床位要租出去"或"我在找房/找室友"这类具体请求时，才判 seeker/lister。
- 「找室友」需结合上下文：若已有房并出租床位→lister；若找房并求合租→seeker。
- 如果既不是清晰的招租，也不是清晰的求租，判 other，不要强行归类。

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
      intent: "other",
      confidence: 0.3,
      reason: `AI 分类失败，无法确认交易意图，保守归入非交易帖: ${message}`,
      source: "rule",
    };
  }
}
