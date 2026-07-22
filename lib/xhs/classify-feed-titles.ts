import { generateObject } from "ai";
import { z } from "zod";

import { getArkModel } from "@/lib/ai/ark";

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
      reason: z.string(),
    })
  ),
});

const SYSTEM_PROMPT = `你是小红书标题分类器，判断标题是否属于「美国湾区租房/找室友交易帖」。

判定标准：related=true 仅当标题明确表达了具体的住房交易意图——
即有人在「出租/转租/求租/找房/找室友/合租/subletting/room available/roommate wanted」等，
正在提供或寻找一个具体的房源/床位/室友名额。

即使标题提到了湾区地名（San Jose、Cupertino、Fremont 等）或含有"房""租"等字，
只要没有具体的住房交易意图，也必须判为 related=false，包括但不限于：
- 经验分享、攻略、总结、科普、政策解读、注意事项、吐槽、生活记录
- 团购、拼邮、拼团、代购、拼车、顺风车
- 二手物品买卖/置换（家具、日用品等，即使可能用于新家）
- 招聘、兼职、找工作
- 社交活动、聚会、约练、相亲、交友
- 美食探店、旅游观光、购物分享
- 房价行情讨论、买房投资讨论（买卖房产不是「租房」）

只有标题本身清楚表明"我有房/床位要租出去"或"我在找房/找室友"这类具体交易请求时才判 true。
如果无法确定，请判为 false（宁可漏检也不要误判）。

confidence 表示你对这次判断把握程度的高低，不是"相关程度"的强弱。

为每个标题输出 index / related / confidence / reason，reason 用一句话说明关键依据。`;

export async function classifyFeedTitles(
  titles: string[]
): Promise<FeedTitleJudgement[]> {
  if (titles.length === 0) {
    return [];
  }

  const userPrompt = titles
    .map((title, index) => `${index}. ${title.slice(0, 200)}`)
    .join("\n");

  try {
    const { object } = await generateObject({
      model: getArkModel(),
      schema: batchSchema,
      temperature: 0,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
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
