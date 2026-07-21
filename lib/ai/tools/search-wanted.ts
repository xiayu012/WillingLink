/**
 * searchWanted tool — keyword search over XhsRentalWanted (tenant-seeking posts).
 *
 * Used by landlords / property owners looking for tenants or roommates.
 * No vector index on this table, so search cascade is keyword-based:
 *
 *  Phase 1 — location + keywords, strict block filter → UP TO 4 exact matches
 *  Phase 2 — location + keywords, relaxed (drop block filter) → 1 post
 *  Phase 3 — location only (drop extra keywords) → 1 post
 *  Phase 4 — recent 50 posts as last resort → 1 post
 *
 * Exact matches return up to 4 posts at once; any relaxation returns exactly
 * one post plus a relaxedNote that the assistant surfaces to the user.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  getSeenListingIds,
  incrementSearchAttempts,
  markListingAsSeen,
} from "@/lib/db/seen-listings";
import {
  searchXhsRentalWanted,
  type XhsRentalWantedSearchResultRow,
} from "@/lib/db/queries";

// ── Location detection ────────────────────────────────────────────────────────

const LOCATION_ENTRIES: { re: RegExp; canonical: string }[] = [
  { re: /圣何塞|San\s*Jose/i, canonical: "San Jose" },
  { re: /旧金山|三藩市|San\s*Francisco|\bSF\b/i, canonical: "San Francisco" },
  { re: /伯克利|Berkeley/i, canonical: "Berkeley" },
  { re: /奥克兰|Oakland/i, canonical: "Oakland" },
  { re: /帕罗奥图|帕洛阿尔托|Palo\s*Alto/i, canonical: "Palo Alto" },
  { re: /山景城|Mountain\s*View/i, canonical: "Mountain View" },
  { re: /桑尼维尔|Sunnyvale/i, canonical: "Sunnyvale" },
  { re: /弗里蒙特|Fremont/i, canonical: "Fremont" },
  { re: /圣克拉拉|Santa\s*Clara/i, canonical: "Santa Clara" },
  { re: /戴利城|Daly\s*City/i, canonical: "Daly City" },
  { re: /库比蒂诺|Cupertino/i, canonical: "Cupertino" },
  { re: /圣马特奥|San\s*Mateo/i, canonical: "San Mateo" },
  { re: /红木城|Redwood\s*City/i, canonical: "Redwood City" },
  { re: /Milpitas/i, canonical: "Milpitas" },
  { re: /Hayward/i, canonical: "Hayward" },
  { re: /Menlo\s*Park|门洛帕克/i, canonical: "Menlo Park" },
  { re: /Los\s*Altos/i, canonical: "Los Altos" },
  { re: /Saratoga/i, canonical: "Saratoga" },
  { re: /Campbell/i, canonical: "Campbell" },
  { re: /Foster\s*City/i, canonical: "Foster City" },
  { re: /Burlingame/i, canonical: "Burlingame" },
  { re: /South\s*Bay|南湾/i, canonical: "South Bay" },
  { re: /East\s*Bay|东湾/i, canonical: "East Bay" },
  { re: /Peninsula|半岛/i, canonical: "Peninsula" },
  { re: /湾区|Bay\s*Area/i, canonical: "湾区" },
];

function detectLocation(query: string): string | null {
  for (const entry of LOCATION_ENTRIES) {
    if (entry.re.test(query)) return entry.canonical;
  }
  return null;
}

// ── Keyword extraction ────────────────────────────────────────────────────────

const WANTED_KEYWORDS: string[] = [
  "主卧", "次卧", "客卧",
  "studio", "Studio",
  "整租", "合租", "转租", "sublease",
  "短租", "长租",
  "宠物", "pet", "猫", "狗",
  "情侣", "couples",
  "女生", "男生", "female", "male",
  "实习", "intern", "学生",
  "1B1B", "2B2B", "1b1b", "2b2b",
];

function extractKeywords(query: string): string[] {
  const found: string[] = [];
  for (const kw of WANTED_KEYWORDS) {
    if (query.toLowerCase().includes(kw.toLowerCase())) found.push(kw);
  }
  // bedroom count pattern
  const bedroomMatch = query.match(/(\d)\s*(?:br|bed|室|卧|房)/i);
  if (bedroomMatch) found.push(bedroomMatch[0]);
  return [...new Set(found)];
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function filterExcluded(
  rows: XhsRentalWantedSearchResultRow[],
  excludeIds: string[]
): XhsRentalWantedSearchResultRow[] {
  if (excludeIds.length === 0) return rows;
  return rows.filter((r) => !excludeIds.includes(r.id));
}

function applyBlockFilter(
  rows: XhsRentalWantedSearchResultRow[],
  blockTerms: string[]
): XhsRentalWantedSearchResultRow[] {
  if (blockTerms.length === 0) return rows;
  return rows.filter((r) => {
    const text = [r.rawText, r.title ?? "", r.requirements ?? ""]
      .join(" ")
      .toLowerCase();
    return !blockTerms.some((term) => text.includes(term));
  });
}

function pickOne(
  rows: XhsRentalWantedSearchResultRow[]
): XhsRentalWantedSearchResultRow {
  const pool = rows.slice(0, Math.min(3, rows.length));
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Take the most-recent `n` posts (rows already arrive newest-first). */
function pickTop(
  rows: XhsRentalWantedSearchResultRow[],
  n: number
): XhsRentalWantedSearchResultRow[] {
  return rows.slice(0, n);
}

// ── Config ────────────────────────────────────────────────────────────────────

/** Max exact-match posts returned in a single call. */
export const EXACT_MATCH_MAX = 4;

/**
 * Once a chat has triggered this many searches, the tool starts nudging the
 * assistant that it has tried hard enough and may honestly conclude the
 * database has nothing better. The assistant still decides for itself.
 */
export const SEARCH_ATTEMPT_HINT_THRESHOLD = 5;

// ── Search cascade ────────────────────────────────────────────────────────────

type CascadeResult = {
  /** 1–4 exact matches, or exactly one post when criteria were relaxed. */
  wanted: XhsRentalWantedSearchResultRow[];
  relaxedNote: string | null;
} | null;

export async function findNextWanted(
  query: string,
  excludeIds: string[],
  blockTerms: string[]
): Promise<CascadeResult> {
  const location = detectLocation(query);
  const keywords = extractKeywords(query);

  // Phase 1 — location + keywords, strict → up to 4 exact matches
  if (location || keywords.length > 0) {
    const { results } = await searchXhsRentalWanted({
      preferredLocation: location,
      keywords: keywords.length > 0 ? keywords : undefined,
    });
    const unseen = filterExcluded(results, excludeIds);

    const strict = applyBlockFilter(unseen, blockTerms);
    if (strict.length > 0) {
      return { wanted: pickTop(strict, EXACT_MATCH_MAX), relaxedNote: null };
    }

    // Phase 2 — drop block filter → one relaxed post
    if (unseen.length > 0) {
      return {
        wanted: [pickOne(unseen)],
        relaxedNote:
          "找不到完全符合要求的求租帖，已放宽部分限制条件，先给你看一条最接近的",
      };
    }
  }

  // Phase 3 — location only, drop keywords → one relaxed post
  if (location && keywords.length > 0) {
    const { results } = await searchXhsRentalWanted({ preferredLocation: location });
    const unseen = filterExcluded(results, excludeIds);

    const strict = applyBlockFilter(unseen, blockTerms);
    if (strict.length > 0) {
      return {
        wanted: [pickOne(strict)],
        relaxedNote: `找不到完全符合要求的，已放宽关键词，仅保留${location}地区筛选，先给你看一条`,
      };
    }
    if (unseen.length > 0) {
      return {
        wanted: [pickOne(unseen)],
        relaxedNote: `找不到完全符合要求的，已放宽限制，先给你看一条${location}地区的求租帖`,
      };
    }
  }

  // Phase 4 — last resort: one post from the 50 most recent
  const { results: recent } = await searchXhsRentalWanted({ limit: 50 });
  const unseen = filterExcluded(recent, excludeIds);
  if (unseen.length > 0) {
    return {
      wanted: [pickOne(unseen)],
      relaxedNote: "暂无精确匹配的求租帖，已从最近发布的帖子中为你挑一条",
    };
  }

  return null;
}

/**
 * When the chat has searched enough times without satisfying the user, returns
 * a note telling the assistant it may — at its own discretion — stop cycling
 * and honestly say the database has nothing better. Empty string otherwise.
 */
export function exhaustionNotice(attempts: number): string {
  if (attempts < SEARCH_ATTEMPT_HINT_THRESHOLD) return "";
  return (
    ` EXHAUSTION_NOTICE: 这轮对话你已经搜索了 ${attempts} 次。` +
    "如果用户仍然不满意，请自行判断：可以坦诚告诉对方数据库里暂时没有更合适的求租帖，" +
    "建议调整条件或稍后再来，不要机械地无限“换一个”。"
  );
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export function createSearchWantedTool(chatId: string) {
  return tool({
    description:
      "Search the XhsRentalWanted database for tenant-seeking posts (求租信息). " +
      "Call this when the user is a LANDLORD or PROPERTY OWNER looking to find tenants or roommates. " +
      "Returns UP TO 4 unseen exact-match posts, or exactly ONE relaxed post (with relaxedNote) when no exact match exists. " +
      "Call again for '换一个'/'next'/'不满意' — server deduplicates automatically and tracks how many times you've searched.",
    inputSchema: z.object({
      query: z.string().describe(
        "Full natural language description of the tenant the landlord is looking for. " +
        "Include location, room type, lease duration, budget expectation, gender preference, etc. " +
        "Carry ALL context forward from the conversation on every call. " +
        "Example: '旧金山女生室友，2B2B，长租，预算2000-2500，不养宠物'"
      ),
      mustNotContain: z
        .array(z.string())
        .optional()
        .describe(
          "Keywords that disqualify a post if found in its text. " +
          "Accumulate across turns. Examples: ['中介', '转租'] to exclude subletting posts."
        ),
    }),
    execute: async ({ query, mustNotContain }) => {
      try {
        const excludeIds = await getSeenListingIds(chatId);
        const blockTerms = (mustNotContain ?? [])
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t.length > 0);

        const attempts = await incrementSearchAttempts(chatId);
        const exhaustion = exhaustionNotice(attempts);

        const result = await findNextWanted(query, excludeIds, blockTerms);

        if (!result) {
          return {
            wanted: [],
            count: 0,
            relaxedNote: null,
            action:
              (excludeIds.length > 0
                ? "NO_MORE: 已经没有更多符合条件的求租帖了。建议调整筛选条件再试。"
                : "NO_RESULTS: 数据库暂无可推荐的求租帖，请稍后再试。") + exhaustion,
          };
        }

        for (const post of result.wanted) {
          await markListingAsSeen(chatId, post.id);
        }

        if (result.relaxedNote) {
          return {
            wanted: result.wanted,
            count: result.wanted.length,
            relaxedNote: result.relaxedNote,
            action:
              "SHOW_RELAXED_WANTED: No exact match found; criteria were auto-relaxed. " +
              "Show relaxedNote in italics as the first line, then display the SINGLE post in standard format. " +
              "End with: '如仍不满意，可告诉我具体要求，我再为您调整。' " +
              "For subsequent '换一个': call searchWanted again with the SAME query." +
              exhaustion,
          };
        }

        return {
          wanted: result.wanted,
          count: result.wanted.length,
          relaxedNote: null,
          action:
            `SHOW_WANTED: Display these ${result.wanted.length} exact-match tenant-seeking post(s), each as its own block in standard format. ` +
            "For '换一个'/'next'/'不满意': call searchWanted again with the SAME query — " +
            "server automatically excludes already-shown posts." +
            exhaustion,
        };
      } catch (error) {
        console.error("[searchWanted] tool error:", error);
        return {
          wanted: [],
          count: 0,
          relaxedNote: null,
          action: "SEARCH_FAILED: Tell the user the search hit a temporary error and ask them to retry.",
        };
      }
    },
  });
}
