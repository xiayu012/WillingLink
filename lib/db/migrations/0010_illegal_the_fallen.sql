CREATE TABLE IF NOT EXISTS "RentalCrawlRunPost" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"postId" text NOT NULL,
	"isPinned" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "RentalCrawlRunPost_run_post_unique" ON "RentalCrawlRunPost" USING btree ("runId","postId");