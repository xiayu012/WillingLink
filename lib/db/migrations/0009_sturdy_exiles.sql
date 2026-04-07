CREATE TABLE IF NOT EXISTS "RentalCrawlRun" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sourceSite" text NOT NULL,
	"sourceForum" text NOT NULL,
	"startedAt" timestamp NOT NULL,
	"endedAt" timestamp,
	"status" varchar DEFAULT 'running' NOT NULL,
	"pagesCrawled" integer DEFAULT 0 NOT NULL,
	"newCount" integer DEFAULT 0 NOT NULL,
	"updatedCount" integer DEFAULT 0 NOT NULL,
	"skippedCount" integer DEFAULT 0 NOT NULL,
	"errorCount" integer DEFAULT 0 NOT NULL,
	"stopReason" text,
	"errorMessage" text,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "RentalPost" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sourceSite" text NOT NULL,
	"sourceForum" text NOT NULL,
	"postId" text NOT NULL,
	"detailUrl" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"publishedAt" timestamp with time zone,
	"publishedAtRaw" text,
	"replyCount" integer,
	"viewCount" integer,
	"isPinned" boolean DEFAULT false NOT NULL,
	"contentText" text NOT NULL,
	"contactRaw" text,
	"priceRaw" text,
	"locationRaw" text,
	"structured" json NOT NULL,
	"contentHash" text NOT NULL,
	"rawJson" json NOT NULL,
	"firstSeenAt" timestamp NOT NULL,
	"lastSeenAt" timestamp NOT NULL,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "RentalPost_source_post_unique" ON "RentalPost" USING btree ("sourceSite","sourceForum","postId");