export type FeedTitleJudgement = {
  index: number;
  related: boolean;
  confidence: number;
  reason: string;
};

const SYSTEM_PROMPT = `你是小红书标题分类器，判断标题是否属于「美国湾区租房交易帖」。

相关（related=true）：
- 出租、转租、短租、招租、求租、找房、找室友、roommate、sublease 等真实找房/出租信息

不相关（related=false）：
- 避雷、攻略、经验分享、科普、总结、政策解读、注意事项、吐槽、生活记录
- 仅提到「湾区」「租房」但没有具体交易意图的资讯帖

只输出 JSON，格式：
{"results":[{"index":0,"related":true,"confidence":0.9,"reason":"一句话"}]}`;

export async function classifyFeedTitles(
  titles: string[]
): Promise<FeedTitleJudgement[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || titles.length === 0) {
    return [];
  }

  const userPrompt = titles
    .map((title, index) => `${index}. ${title.slice(0, 200)}`)
    .join("\n");

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
        temperature: 0,
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } catch {
    return [];
  }

  if (!resp.ok) {
    return [];
  }

  try {
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    const jsonStart = content.indexOf("{");
    const jsonEnd = content.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      return [];
    }
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1)) as {
      results?: {
        index?: number;
        related?: boolean;
        confidence?: number;
        reason?: string;
      }[];
    };
    const results: FeedTitleJudgement[] = [];
    for (const item of parsed.results ?? []) {
      const index = Number(item.index);
      if (!Number.isInteger(index)) {
        continue;
      }
      results.push({
        index,
        related: Boolean(item.related),
        confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0.5)),
        reason:
          typeof item.reason === "string" ? item.reason : "AI 未提供原因",
      });
    }
    return results;
  } catch {
    return [];
  }
}
