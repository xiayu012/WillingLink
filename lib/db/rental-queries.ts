import "server-only";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { ChatSDKError } from "@/lib/errors";
import type { RentalStructuredData } from "@/lib/rental/parser";
import { rentalCrawlRun, rentalCrawlRunPost, rentalPost } from "./schema";

const client = postgres(process.env.POSTGRES_URL!);
const db = drizzle(client);

type RentalPostUpsertInput = {
  sourceSite: string;
  sourceForum: string;
  postId: string;
  detailUrl: string;
  title: string;
  author: string | null;
  publishedAt: Date | null;
  publishedAtRaw: string | null;
  replyCount: number | null;
  viewCount: number | null;
  isPinned: boolean;
  contentText: string;
  contactRaw: string | null;
  priceRaw: string | null;
  locationRaw: string | null;
  structured: RentalStructuredData;
  contentHash: string;
  rawJson: Record<string, unknown>;
  seenAt: Date;
};

export async function createRentalCrawlRun(params: {
  sourceSite: string;
  sourceForum: string;
}) {
  const now = new Date();

  try {
    const [createdRun] = await db
      .insert(rentalCrawlRun)
      .values({
        sourceSite: params.sourceSite,
        sourceForum: params.sourceForum,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: rentalCrawlRun.id });

    return createdRun.id;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to create rental crawl run"
    );
  }
}

export async function completeRentalCrawlRun(params: {
  runId: string;
  pagesCrawled: number;
  newCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  stopReason: string | null;
}) {
  const now = new Date();

  try {
    await db
      .update(rentalCrawlRun)
      .set({
        status: "success",
        endedAt: now,
        pagesCrawled: params.pagesCrawled,
        newCount: params.newCount,
        updatedCount: params.updatedCount,
        skippedCount: params.skippedCount,
        errorCount: params.errorCount,
        stopReason: params.stopReason,
        updatedAt: now,
      })
      .where(eq(rentalCrawlRun.id, params.runId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to complete rental crawl run"
    );
  }
}

export async function failRentalCrawlRun(params: {
  runId: string;
  pagesCrawled: number;
  newCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  stopReason: string | null;
  errorMessage: string;
}) {
  const now = new Date();

  try {
    await db
      .update(rentalCrawlRun)
      .set({
        status: "failed",
        endedAt: now,
        pagesCrawled: params.pagesCrawled,
        newCount: params.newCount,
        updatedCount: params.updatedCount,
        skippedCount: params.skippedCount,
        errorCount: params.errorCount,
        stopReason: params.stopReason,
        errorMessage: params.errorMessage,
        updatedAt: now,
      })
      .where(eq(rentalCrawlRun.id, params.runId));
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to fail crawl run");
  }
}

export async function getRentalPostBySourcePostId(params: {
  sourceSite: string;
  sourceForum: string;
  postId: string;
}) {
  try {
    const [existingPost] = await db
      .select()
      .from(rentalPost)
      .where(
        and(
          eq(rentalPost.sourceSite, params.sourceSite),
          eq(rentalPost.sourceForum, params.sourceForum),
          eq(rentalPost.postId, params.postId)
        )
      )
      .limit(1);

    return existingPost ?? null;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get rental post by source post id"
    );
  }
}

export async function createRentalPost(input: RentalPostUpsertInput) {
  try {
    await db.insert(rentalPost).values({
      sourceSite: input.sourceSite,
      sourceForum: input.sourceForum,
      postId: input.postId,
      detailUrl: input.detailUrl,
      title: input.title,
      author: input.author,
      publishedAt: input.publishedAt,
      publishedAtRaw: input.publishedAtRaw,
      replyCount: input.replyCount,
      viewCount: input.viewCount,
      isPinned: input.isPinned,
      contentText: input.contentText,
      contactRaw: input.contactRaw,
      priceRaw: input.priceRaw,
      locationRaw: input.locationRaw,
      structured: input.structured,
      contentHash: input.contentHash,
      rawJson: input.rawJson,
      firstSeenAt: input.seenAt,
      lastSeenAt: input.seenAt,
      createdAt: input.seenAt,
      updatedAt: input.seenAt,
    });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to create rental post");
  }
}

export async function createRentalCrawlRunPost(params: {
  runId: string;
  postId: string;
  isPinned: boolean;
  createdAt: Date;
}) {
  try {
    await db.insert(rentalCrawlRunPost).values({
      runId: params.runId,
      postId: params.postId,
      isPinned: params.isPinned,
      createdAt: params.createdAt,
    });
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to create rental crawl run post"
    );
  }
}

export async function hasRentalCrawlRunSeenPost(params: {
  postId: string;
  sourceSite: string;
  sourceForum: string;
}) {
  try {
    const [seenPost] = await client`
      SELECT rcrp."id"
      FROM "RentalCrawlRunPost" rcrp
      INNER JOIN "RentalCrawlRun" rcr ON rcrp."runId" = rcr."id"
      WHERE rcr."sourceSite" = ${params.sourceSite}
        AND rcr."sourceForum" = ${params.sourceForum}
        AND rcrp."postId" = ${params.postId}
        AND rcr."status" = 'success'
      LIMIT 1
    `;

    return Boolean(seenPost);
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to query rental crawl run seen post"
    );
  }
}

export async function updateRentalPostById(params: {
  id: string;
  detailUrl: string;
  title: string;
  author: string | null;
  publishedAt: Date | null;
  publishedAtRaw: string | null;
  replyCount: number | null;
  viewCount: number | null;
  isPinned: boolean;
  contentText: string;
  contactRaw: string | null;
  priceRaw: string | null;
  locationRaw: string | null;
  structured: RentalStructuredData;
  contentHash: string;
  rawJson: Record<string, unknown>;
  seenAt: Date;
}) {
  try {
    await db
      .update(rentalPost)
      .set({
        detailUrl: params.detailUrl,
        title: params.title,
        author: params.author,
        publishedAt: params.publishedAt,
        publishedAtRaw: params.publishedAtRaw,
        replyCount: params.replyCount,
        viewCount: params.viewCount,
        isPinned: params.isPinned,
        contentText: params.contentText,
        contactRaw: params.contactRaw,
        priceRaw: params.priceRaw,
        locationRaw: params.locationRaw,
        structured: params.structured,
        contentHash: params.contentHash,
        rawJson: params.rawJson,
        lastSeenAt: params.seenAt,
        updatedAt: params.seenAt,
      })
      .where(eq(rentalPost.id, params.id));
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to update rental post");
  }
}
