/**
 * 小红书帖子内容分类器（用于复制正文入库时路由）
 *
 * 分三类：
 *   - "listing" : 房东/二房东发布出租、转租、招室友帖
 *   - "wanted"  : 租客发布求租、找房、寻室友帖
 *   - "other"   : 经验总结、科普、其他（不入库）
 */

export type PostCategory = "listing" | "wanted" | "other";

const LISTING_KEYWORDS = [
  "出租",
  "转租",
  "sublease",
  "for rent",
  "招室友",
  "找室友",
  "roommate wanted",
  "room available",
  "available for rent",
  "lease available",
  "月租",
  "租金",
  "deposit",
  "押金",
] as const;

const WANTED_KEYWORDS = [
  "求租",
  "寻租",
  "找房",
  "找个房",
  "在找房",
  "想找房",
  "求房",
  "寻房",
  "求室友",
  "找室友住",
  "需要一间",
  "looking for a room",
  "looking for an apartment",
  "need a room",
  "need a place",
  "seeking",
  "wanted",
  "want to rent",
  "in search of",
] as const;

const OTHER_KEYWORDS = [
  "干货",
  "攻略",
  "经验分享",
  "避坑",
  "注意事项",
  "科普",
  "总结一下",
  "新手必看",
  "小白",
  "tips",
  "guide",
  "注意：",
] as const;

function countKeywordHits(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) {
      hits += 1;
    }
  }
  return hits;
}

function ruleClassify(rawText: string): PostCategory | null {
  const listingHits = countKeywordHits(rawText, LISTING_KEYWORDS);
  const wantedHits = countKeywordHits(rawText, WANTED_KEYWORDS);
  const otherHits = countKeywordHits(rawText, OTHER_KEYWORDS);

  if (wantedHits >= 1 && wantedHits > listingHits) {
    return "wanted";
  }

  if (listingHits >= 1 && listingHits > wantedHits) {
    return "listing";
  }

  if (otherHits >= 2 && listingHits === 0 && wantedHits === 0) {
    return "other";
  }

  return null;
}

const SYSTEM_PROMPT = `你是一个小红书帖子分类器，专门处理美国湾区租房类帖子。
将帖子分为三类，仅输出 JSON，不输出任何其他内容：

{
  "category": "listing" | "wanted" | "other",
  "reason": "一句话说明理由"
}

类别说明：
- listing：房东或二房东发布的出租/转租/找室友帖（有房出租）
- wanted：租客发布的求租/找房帖（在找住所）
- other：经验分享、攻略总结、科普、生活记录等非交易帖`;

// Every default-to-"listing" path is a silent misclassification risk: a
// transient OpenAI blip biases posts into the listing table (where they then
// get embedded and stored). Behavior is unchanged, but each fallback now logs
// a stable, greppable reason so these can be counted/alerted on.
function fallbackListing(reason: string): PostCategory {
  console.warn(`[classifyPost] falling back to "listing": ${reason}`);
  return "listing";
}

async function aiClassify(rawText: string): Promise<PostCategory> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return fallbackListing("OPENAI_API_KEY not set");
  }

  const excerpt = rawText.slice(0, 600);

  let resp: Response;
  try {
    resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 80,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `帖子正文：\n${excerpt}` },
        ],
      }),
    });
  } catch (err) {
    return fallbackListing(
      `fetch threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!resp.ok) {
    return fallbackListing(`OpenAI HTTP ${resp.status}`);
  }

  try {
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    const jsonStart = content.indexOf("{");
    const jsonEnd = content.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      return fallbackListing("no JSON object in model output");
    }
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1)) as {
      category?: string;
    };
    const cat = parsed.category;
    if (cat === "listing" || cat === "wanted" || cat === "other") {
      return cat;
    }
    return fallbackListing(`unexpected category: ${String(cat)}`);
  } catch (err) {
    return fallbackListing(
      `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function classifyPost(rawText: string): Promise<PostCategory> {
  const ruleResult = ruleClassify(rawText);
  if (ruleResult !== null) {
    return ruleResult;
  }
  return aiClassify(rawText);
}
