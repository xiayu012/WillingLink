-- SearchQueryLog: searchRental 查询留档（评测抽样 + 不满意信号数据源）
CREATE TABLE IF NOT EXISTS "SearchQueryLog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chatId" text NOT NULL,
	"query" text NOT NULL,
	"mustNotContain" json,
	"phase" text NOT NULL,
	"listingId" uuid,
	"relaxed" boolean DEFAULT false NOT NULL,
	"durationMs" integer,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- 以下为 schema 快照追平（这些列在生产库均已存在，语句全部幂等）：
-- drizzle generate 检测到快照落后于线上，一并补齐以免后续 generate 反复混入
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "signUpUserName" text;--> statement-breakpoint
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "signUpAudioUrl" text;--> statement-breakpoint
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "signUpAudioDurationMs" integer;--> statement-breakpoint
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "signUpAudioMimeType" text;--> statement-breakpoint
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "signUpAudioSizeBytes" integer;--> statement-breakpoint
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "signUpCreatedAt" timestamp with time zone;
