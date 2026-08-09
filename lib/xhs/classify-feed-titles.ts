import { generateObject } from "ai";
import { z } from "zod";

import { getFeedTitleModel } from "@/lib/ai/providers";

export type FeedTitleJudgement = {
  index: number;
  related: boolean;
  confidence: number;
  reason: string;
};

const batchSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int().min(0),
      related: z.boolean(),
      confidence: z.number().min(0).max(1),
      reason: z.string().max(24),
    })
  ),
});

// 油猴脚本已先用离线地理索引硬门控；这里只判交易意图，提示词尽量短以压延迟。
const SYSTEM_PROMPT = `地点已确认为旧金山湾区核心五县。只判断标题是否在提供或寻找具体住房/床位/室友名额。
true：出租、转租、求租、找房、合租、找室友。
false：攻略避雷、拼邮拼车、二手、招聘、社交、买房房价、普通生活。
不确定则 false。reason 不超过 12 字。`;

export async function classifyFeedTitles(
  titles: string[]
): Promise<FeedTitleJudgement[]> {
  if (titles.length === 0) {
    return [];
  }

  const userPrompt = titles
    .map((title, index) => `${index}. ${title.slice(0, 120)}`)
    .join("\n");

  try {
    const { object } = await generateObject({
      model: getFeedTitleModel(),
      schema: batchSchema,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      temperature: 0,
      maxOutputTokens: Math.min(48 + titles.length * 28, 360),
    });

    return object.results.map((item) => ({
      index: item.index,
      related: item.related,
      confidence: item.confidence,
      reason: item.reason || "AI 未提供原因",
    }));
  } catch (error) {
    console.error("[classify-feed-titles] failed:", error);
    return [];
  }
}
