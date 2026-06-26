/**
 * searchWanted tool — keyword search over XhsRentalWanted (tenant-seeking posts).
 *
 * Used by landlords / property owners looking for tenants or roommates.
 * No vector index on this table, so search cascade is keyword-based:
 *
 *  Phase 1 — location + keywords, strict block filter
 *  Phase 2 — location + keywords, relaxed (drop block filter)
 *  Phase 3 — location only (drop extra keywords)
 *  Phase 4 — recent 50 posts as last resort
 */

import { tool } from "ai";
import { z } from "zod";
import { getSeenListingIds, markListingAsSeen } from "@/lib/db/seen-listings";
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

// ── Search cascade ────────────────────────────────────────────────────────────

type CascadeResult = {
  wanted: XhsRentalWantedSearchResultRow;
  relaxedNote: string | null;
} | null;

async function findNextWanted(
  query: string,
  excludeIds: string[],
  blockTerms: string[]
): Promise<CascadeResult> {
  const location = detectLocation(query);
  const keywords = extractKeywords(query);

  // Phase 1 — location + keywords, strict
  if (location || keywords.length > 0) {
    const { results } = await searchXhsRentalWanted({
      preferredLocation: location,
      keywords: keywords.length > 0 ? keywords : undefined,
    });
    const unseen = filterExcluded(results, excludeIds);

    const strict = applyBlockFilter(unseen, blockTerms);
    if (strict.length > 0) {
      return { wanted: pickOne(strict), relaxedNote: null };
    }

    // Phase 2 — drop block filter
    if (unseen.length > 0) {
      return {
        wanted: pickOne(unseen),
        relaxedNote: "找不到完全符合要求的求租帖，已放宽部分限制条件",
      };
    }
  }

  // Phase 3 — location only, drop keywords
  if (location && keywords.length > 0) {
    const { results } = await searchXhsRentalWanted({ preferredLocation: location });
    const unseen = filterExcluded(results, excludeIds);

    const strict = applyBlockFilter(unseen, blockTerms);
    if (strict.length > 0) {
      return {
        wanted: pickOne(strict),
        relaxedNote: `已放宽关键词限制，仅保留${location}地区筛选`,
      };
    }
    if (unseen.length > 0) {
      return {
        wanted: pickOne(unseen),
        relaxedNote: `已放宽限制，为您展示${location}地区的求租帖`,
      };
    }
  }

  // Phase 4 — last resort: 50 most recent
  const { results: recent } = await searchXhsRentalWanted({ limit: 50 });
  const unseen = filterExcluded(recent, excludeIds);
  if (unseen.length > 0) {
    return {
      wanted: pickOne(unseen),
      relaxedNote: "暂无精确匹配的求租帖，已从最近发布的帖子中为您推荐",
    };
  }

  return null;
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export function createSearchWantedTool(chatId: string) {
  return tool({
    description:
      "Search the XhsRentalWanted database for tenant-seeking posts (求租信息). " +
      "Call this when the user is a LANDLORD or PROPERTY OWNER looking to find tenants or roommates. " +
      "Returns ONE unseen post per call. " +
      "Call again for '换一个'/'next'/'不满意' — server deduplicates automatically.",
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

        const result = await findNextWanted(query, excludeIds, blockTerms);

        if (!result) {
          return {
            wanted: null,
            relaxedNote: null,
            action:
              excludeIds.length > 0
                ? "NO_MORE: 已经没有更多符合条件的求租帖了。建议调整筛选条件再试。"
                : "NO_RESULTS: 数据库暂无可推荐的求租帖，请稍后再试。",
          };
        }

        await markListingAsSeen(chatId, result.wanted.id);

        if (result.relaxedNote) {
          return {
            wanted: result.wanted,
            relaxedNote: result.relaxedNote,
            action:
              "SHOW_RELAXED_WANTED: No exact match found; criteria were auto-relaxed. " +
              "Show relaxedNote in italics as the first line, then display the post in standard format. " +
              "End with: '如仍不满意，可告诉我具体要求，我再为您调整。' " +
              "For subsequent '换一个': call searchWanted again with the SAME query.",
          };
        }

        return {
          wanted: result.wanted,
          relaxedNote: null,
          action:
            "SHOW_WANTED: Display this tenant-seeking post in standard format. " +
            "For '换一个'/'next'/'不满意': call searchWanted again with the SAME query — " +
            "server automatically excludes already-shown posts.",
        };
      } catch (error) {
        console.error("[searchWanted] tool error:", error);
        return {
          wanted: null,
          relaxedNote: null,
          action: "SEARCH_FAILED: Tell the user the search hit a temporary error and ask them to retry.",
        };
      }
    },
  });
}
