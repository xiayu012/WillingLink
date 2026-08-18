-- 多渠道聊天：外部身份映射 + 消息来源标签
--
-- 手动执行（Neon 控制台），不进 drizzle journal —— 与 XhsRentalListing 一样的
-- "一次性建表"做法，见 tools/xhs-guide/README.md。
--
-- 第 1 段是 adapter 能跑起来的最低要求；第 2 段是消息打渠道标签，等真的要在
-- 网页上区分"这条是从短信来的"时再跑，跑完记得把两列补进 lib/db/schema.ts 的
-- message 定义（不补进去 drizzle 查不到，补早了库里没列会直接报错）。

-- ---------- 1. 外部身份映射 ----------
CREATE TABLE IF NOT EXISTS "ChannelIdentity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "userId" uuid NOT NULL REFERENCES "User"("id"),
  "channel" varchar(32) NOT NULL,
  "externalUserId" varchar(128) NOT NULL,
  "accountId" varchar(128),
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChannelIdentity_channel_external_unique"
  ON "ChannelIdentity" ("channel", "externalUserId");

CREATE INDEX IF NOT EXISTS "ChannelIdentity_userId_idx"
  ON "ChannelIdentity" ("userId");

-- 身份合并（例如小红书用户后来给了手机号，确认是同一个人）：
--   UPDATE "ChannelIdentity" SET "userId" = '<保留的内部 userId>'
--   WHERE "channel" = 'sms' AND "externalUserId" = '+1408...';
-- 历史消息要跟过去的话，同时把那个 user 名下的 Chat.userId 一起改。
-- 真正的合并流程（谁并谁、冲突怎么办）等有第二个渠道上线时再定。

-- ---------- 2. 消息来源标签（可以晚点再跑） ----------
-- ALTER TABLE "Message_v2" ADD COLUMN IF NOT EXISTS "channel" varchar(32);
-- ALTER TABLE "Message_v2" ADD COLUMN IF NOT EXISTS "externalMessageId" varchar(128);
-- CREATE UNIQUE INDEX IF NOT EXISTS "Message_v2_externalMessageId_unique"
--   ON "Message_v2" ("externalMessageId") WHERE "externalMessageId" IS NOT NULL;
