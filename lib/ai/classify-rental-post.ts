import { generateObject } from "ai";
import { z } from "zod";

import { getTitleModel } from "@/lib/ai/providers";

export type RentalPostIntent = "seeker" | "lister";

export type RentalPostClassification = {
  intent: RentalPostIntent;
  confidence: number;
  reason: string;
  source: "rule" | "ai";
};

const classificationSchema = z.object({
  intent: z.enum(["seeker", "lister"]),
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

export async function classifyRentalPostIntent(
  rawText: string
): Promise<RentalPostClassification> {
  const ruleResult = ruleBasedClassify(rawText);
  if (ruleResult && ruleResult.confidence >= 0.82) {
    return ruleResult;
  }

  try {
    const { object } = await generateObject({
      model: getTitleModel(),
      schema: classificationSchema,
      system: `你是美国湾区租房帖分类器。判断发帖人是「求租者」还是「招租者」。

seeker（求租者）：
- 自己在找房、求租、找合租位、找室友加入
- 描述预算、期望入住时间、意向区域、户型偏好
- 没有现成房源可出租

lister（招租者）：
- 房东、转租者、已有租约并出租房间
- 描述现有房源、租金、可入住时间、房屋条件
- 招租或转租

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
