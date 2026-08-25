import "server-only";

import { generateObject } from "ai";
import { z } from "zod";
import { getFeedTitleModel } from "@/lib/ai/providers";
import {
  classifyPostKindByRule,
  type PostKindResult,
} from "@/lib/xhs/post-kind-rules";

/**
 * 帖子类型判定：**这篇帖子值不值得我们去评论，以及该按什么角色评论。**
 *
 * 为什么不复用入库那套 `classifyRentalPostIntent`：那个只分
 * seeker / lister / other，因为入库只需要知道"这是房源还是求租"。评论要回答的是
 * 另一个问题——**要不要开口**。看房体验帖里全是租房关键词，但帖主没在求租，
 * 冲上去推房源就是牛头不对马嘴（AGENT_LOG 2026-08-25，Case F：Huxley / Indigo /
 * Trestle 那篇实地 tour 感受被当成求租帖）。
 *
 * 两套分类各管各的，别合并：入库关心"这条数据是什么"，评论关心"该不该说话"。
 *
 * 正则快路径在 `post-kind-rules.ts`（无依赖，门禁直接引），这里只负责落到模型。
 */

const schema = z.object({
  kind: z.enum(["seeker", "lister", "roommate", "review", "advice", "other"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

const SYSTEM = `你判断一篇小红书帖子属于哪一类，用来决定要不要去评论区回复房源信息。

- seeker：帖主本人正在找房子住（求租、想租、求转租）
- lister：帖主本人有房要出租（出租、招租、转租自己的房子）
- roommate：帖主本人在找室友一起住（已看好或已租下房子，缺人分摊）
- review：看房体验、公寓测评、踩坑避雷、租房经验分享——**帖主没有在求租或招租**
- advice：提问、求建议、科普攻略
- other：跟租房无关

**前三类的前提是「交易标的是住的地方」。** 卖二手家具、转让健身卡、出二手车、
转让演出票，哪怕写着"出""转""便宜出"、哪怕带了城市名，都是 other——我们能推的
只有房源和找房的人，推给他们等于牛头不对马嘴。
例："搬家出二手家具，宜家沙发床书桌，便宜出，自提，在Sunnyvale" → other，不是 lister。

最容易判错、也最要小心的一条：**看房体验帖里会大量出现公寓名、租金、户型这些词，
但帖主并没有在求租**。判断依据是帖主此刻的诉求，不是文章里出现了什么租房词汇。
例：列举 Huxley / Indigo / Trestle 几个公寓的实地 tour 感受 → review，不是 seeker。`;

/**
 * @param rawText 帖子正文
 */
export async function classifyPostKind(
  rawText: string
): Promise<PostKindResult> {
  const fast = classifyPostKindByRule(rawText);
  if (fast) {
    return fast;
  }

  try {
    const { object } = await generateObject({
      model: getFeedTitleModel(),
      schema,
      system: SYSTEM,
      prompt: rawText.slice(0, 2000),
    });
    return { ...object, source: "ai" };
  } catch (error) {
    // AI SDK 的错误对象不能直接丢给 console.error（见 AGENT_LOG 的 fail-open 事故）
    const name = error instanceof Error ? error.name : "UnknownError";
    console.log("[post-kind] failed", name);
    // 判不出来时按 seeker 放行：宁可多花一次，也不因一次抖动静默关掉功能
    // （这是既有的 fail-open 取舍，跟 post-intent 保持一致）
    return {
      kind: "seeker",
      confidence: 0,
      reason: `分类失败(${name})，按 seeker 放行`,
      source: "ai",
    };
  }
}
