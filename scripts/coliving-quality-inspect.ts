/** Offline regression by default; --judge additionally checks sanitized traces with the real judge.
 * No database imports, no send path. Run with NODE_OPTIONS=--conditions=react-server.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { finalizeJudgment, judgeConversation, type JudgeTurn } from "../lib/chat/coliving/evals/judge";
import { bestSchedulePlans } from "../lib/chat/coliving/scheduling";
import {
  countAcceptedOutbound,
  evaluateReplyReview,
  evaluateTurnReplyReviews,
} from "../lib/chat/coliving/evals/schema";
import {
  claimsContactCompletion,
  extractExplicitFixedStart,
  extractSlotFromInquiry,
  hasDeferredCoordination,
  isLowInformationFollowUp,
  isOpenConflictCase,
  isPrematureCapacityEscape,
  isScheduleSlotInquiry,
  isSimpleAffirmation,
  scheduleContactTextForAct,
  scheduleInquiryConfirmation,
  scheduleSlotMatchesSelfStatement,
} from "../lib/chat/coliving/turn";

async function main() {
  let count = 0;
  const check = (name: string, fn: () => void) => { fn(); count++; console.log(`PASS ${name}`); };
  const bad: JudgeTurn[] = [{
    fromName: "小林", said: "大家的时间都告诉你了，安排好了吗？",
    reply: "方案已经分别发给他们两位了。",
    outbound: [
      { toName: "小周", text: "你可以晚半小时吗？", blocked: true },
      { toName: "小陈", text: "你愿意先用半小时吗？", blocked: true },
    ],
  }];
  check("real delivered false-completion finding fails", () => {
    const r = finalizeJudgment([{ severity: "high", turnIndex: 0, issue: "两条联系均被拦却声称已发出", quote: bad[0].reply }], bad);
    assert.equal(r.verified, true); assert.equal(r.pass, false);
  });
  check("old blocked-contact trace cannot satisfy the outbound gate", () => {
    assert.equal(countAcceptedOutbound(bad[0].outbound), 0);
    assert.equal(countAcceptedOutbound([...bad[0].outbound, { blocked: false }]), 1);
  });
  check("failed or unverified reply review cannot pass the eval gate", () => {
    assert.deepEqual(evaluateReplyReview(undefined).length, 1);
    assert.deepEqual(
      evaluateReplyReview({ verified: false, pass: true, broke: "", why: "模型超时" }).length,
      1
    );
    assert.deepEqual(
      evaluateReplyReview({ verified: true, pass: false, broke: "2", why: "编造事实" }).length,
      1
    );
    assert.deepEqual(
      evaluateReplyReview({ verified: true, pass: true, broke: "", why: "" }),
      []
    );
  });
  check("an earlier red reply review cannot be hidden by a green last turn", () => {
    const failures = evaluateTurnReplyReviews([
      { verified: true, pass: false, broke: "7", why: "承诺未执行" },
      { verified: true, pass: true, broke: "", why: "" },
    ]);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /第1轮/);
  });
  check("substantive medium is not accepted", () => {
    assert.equal(finalizeJudgment([{ severity: "medium", turnIndex: 0, issue: "未完成协调", quote: bad[0].reply }], bad).pass, false);
  });
  check("blocked draft is not a delivered privacy incident", () => {
    const r = finalizeJudgment([{ severity: "high", turnIndex: 0, issue: "仅草稿问题", quote: bad[0].outbound[0].text }], bad);
    assert.equal(r.findings[0].severity, "low"); assert.equal(r.pass, true);
  });
  check("duplicate quote respects selected turn delivery status", () => {
    const turns = [bad[0], { ...bad[0], reply: "没有发成功。", outbound: [{ ...bad[0].outbound[0], blocked: false }] }];
    const r = finalizeJudgment([{ severity: "high", turnIndex: 0, issue: "仅草稿问题", quote: bad[0].outbound[0].text }], turns);
    assert.equal(r.findings[0].severity, "low");
  });
  check("judge cannot call a delivered target blocked", () => {
    const turns: JudgeTurn[] = [{
      fromName: "小陈",
      said: "请问老孙",
      reply: "我已经向老孙发出消息。",
      outbound: [{ toName: "老孙", text: "你需要用多久？", blocked: false }],
    }];
    const result = finalizeJudgment([{
      severity: "high",
      turnIndex: 0,
      issue: "声称联系老孙，但发给老孙的消息被审稿拦下、没有真的发出去",
      quote: turns[0].reply,
    }], turns);
    assert.equal(result.verified, true);
    assert.equal(result.pass, true);
    assert.deepEqual(result.findings, []);
  });
  check("judge cannot call a turn with accepted outbound no progress", () => {
    const turns: JudgeTurn[] = [{
      fromName: "小周",
      said: "我随时都行，半小时就够",
      reply: "我还在问另外两位，收齐后一起排。",
      outbound: [{ toName: "房东", text: "你一般需要用多久？", blocked: false }],
    }];
    const result = finalizeJudgment([{
      severity: "high",
      turnIndex: 0,
      issue: "只承诺以后再排，没有真正推进排方案或联系人，任务实质性落空",
      quote: turns[0].reply,
    }], turns);
    assert.equal(result.verified, true);
    assert.equal(result.pass, true);
    assert.deepEqual(result.findings, []);
  });
  check("invented quote is unverified, never green", () => {
    const r = finalizeJudgment([{ severity: "high", turnIndex: 0, issue: "没有原文", quote: "不存在的原话" }], bad);
    assert.equal(r.verified, false); assert.equal(r.pass, false);
  });
  check("empty input is unverified", () => assert.equal(finalizeJudgment([], []).verified, false));
  check("valid style note cannot hide an ungrounded serious finding", () => {
    const r = finalizeJudgment([
      { severity: "low", turnIndex: 0, issue: "文风", quote: bad[0].reply },
      { severity: "high", turnIndex: 0, issue: "无证据", quote: "不存在的原话" },
    ], bad);
    assert.equal(r.verified, false); assert.equal(r.pass, false);
  });
  check("fullwidth punctuation does not discard real evidence", () => {
    const turns = [{ ...bad[0], reply: "记下了，你这边定七点。" }];
    assert.equal(finalizeJudgment([{ severity: "medium", turnIndex: 0, issue: "未同意就定案", quote: "记下了,你这边定七点。" }], turns).pass, false);
    assert.equal(finalizeJudgment([{ severity: "medium", turnIndex: 0, issue: "未同意就定案", quote: "记下了,你这边定七点。" }], turns).verified, true);
  });
  check("style-only finding does not block", () => assert.equal(finalizeJudgment([{ severity: "low", turnIndex: 0, issue: "文风", quote: bad[0].reply }], bad).pass, true));
  check("deferred third-party action promise is detected narrowly", () => {
    assert.equal(
      hasDeferredCoordination(
        "傍晚厨房怎么安排，我先把几位的时段问齐再定，定了第一时间发你。"
      ),
      true
    );
    assert.equal(
      hasDeferredCoordination("我会去联系另外两位，收到结果再告诉你。"),
      true
    );
    assert.equal(
      hasDeferredCoordination("你时间灵活，后面排厨房时段好办。"),
      true
    );
    assert.equal(
      hasDeferredCoordination("我还在收其他人的时间，收齐排一版发你。"),
      true
    );
    assert.equal(
      hasDeferredCoordination("我先问你一句：你一般需要用多久？"),
      false
    );
    assert.equal(
      hasDeferredCoordination("我已向另外两位发出征询；收到回复后继续协调。"),
      false
    );
  });
  check("contact completion wording is detected before delivery", () => {
    assert.equal(claimsContactCompletion("我已经向老孙发出消息。"), true);
    assert.equal(claimsContactCompletion("好，我直接问他了。"), true);
    assert.equal(claimsContactCompletion("我还在问另外两位，收齐后一起排。"), true);
    assert.equal(claimsContactCompletion("这轮我也在联系老孙。"), false);
  });
  check("explicit fixed-start wording is recovered from recorded facts", () => {
    assert.equal(extractExplicitFixedStart("我18点到家，只能18点开始做饭，要做两小时"), 1080);
    assert.equal(extractExplicitFixedStart("我必须在 18:30 开始"), 1110);
    assert.equal(extractExplicitFixedStart("七点最合适，但可以调整"), null);
    assert.equal(
      extractExplicitFixedStart("18点才到家，但没有要求必须18点整开始"),
      null
    );
    assert.equal(extractExplicitFixedStart("不是固定在18点开始，可以往后排"), null);
  });
  check("open conflict survives a generic greeting without routing every case as conflict", () => {
    assert.equal(
      isOpenConflictCase({ kind: "kitchen_contention", title: "厨房晚饭时段冲突" }),
      true
    );
    assert.equal(
      isOpenConflictCase({ kind: "repair_request", title: "地下室热水器报修" }),
      false
    );
    assert.equal(isLowInformationFollowUp("你好"), true);
    assert.equal(isLowInformationFollowUp("你好，房租是多少"), false);
  });
  check("capacity escape is blocked until the scheduler proves infeasibility", () => {
    const capacityEscape = "请先看台面插座够不够两人同时开火，我再提小电炉。";
    assert.equal(isPrematureCapacityEscape(capacityEscape, true, false), true);
    assert.equal(isPrematureCapacityEscape(capacityEscape, true, true), false);
    assert.equal(isPrematureCapacityEscape(capacityEscape, false, false), false);
    assert.equal(isPrematureCapacityEscape("我先把三个人的独占时段排出来。", true, false), false);
    assert.equal(isPrematureCapacityEscape("房东说电磁炉不提供，我继续排时段。", true, false), false);
  });

  for (const label of ["厨房", "洗衣机"]) {
    check(`${label}: longer use can be last without violating arrival`, () => {
      const plans = bestSchedulePlans(1080, [
        { name: "长时使用者", durationMinutes: 120, earliestStartMinutes: 0 },
        { name: "短时甲", durationMinutes: 30, earliestStartMinutes: 0, preferredStartMinutes: 60 },
        { name: "短时乙", durationMinutes: 30, earliestStartMinutes: 0 },
      ]);
      assert(plans.some((p) => p.order.at(-1) === "长时使用者"));
      for (const p of plans) {
        for (let i = 0; i < p.assignments.length; i++) {
          assert(p.assignments[i].startMinutes >= 1080);
          if (i) assert(p.assignments[i].startMinutes >= p.assignments[i - 1].endMinutes);
        }
      }
    });
  }
  check("real availability is preserved; longest need not be last", () => {
    const plans = bestSchedulePlans(1080, [
      { name: "长时", durationMinutes: 120, earliestStartMinutes: 0, preferredStartMinutes: 0 },
      { name: "晚归", durationMinutes: 30, earliestStartMinutes: 180 },
    ]);
    assert.equal(plans[0].order[0], "长时");
    for (const p of plans) assert(p.assignments.find((a) => a.name === "晚归")!.startMinutes >= 1260);
  });
  check("production no longer uses time-mention or window-expansion heuristics", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(!src.includes("function checkScheduleHardRule("));
    assert(!src.includes("const pullBackMinutes"));
    assert(src.includes("contacted.delete(msg.personId)"));
    assert(src.includes("bestSchedulePlans(windowStartMinutes, constraints, 5)"));
    assert(src.includes("const finalNeedsAction ="));
    assert(src.includes("await critiqueAndMarkOutbound(finalNewOutbound)"));
    assert(src.includes("const finalScheduleReply = buildSelectedScheduleReply()"));
    assert(src.includes("const settledScheduleReply = buildSelectedScheduleReply()"));
    assert(src.includes('position.kind !== "commitment"'));
    assert(src.includes("ctx.openCases.some(isOpenConflictCase)"));
    assert(!src.includes("!topicHitsConflict ||\n      !toolsUsed.includes(\"recordPosition\")"));
    assert(src.includes("const needsBlockedOutboundRecovery ="));
    assert(src.includes("isGeneratedResidentName(target.name)"));
    assert(src.includes("publicNames.get(assignment.name)"));
    assert(src.includes("const deterministicContactReply ="));
    assert(src.includes("const redoContactReply ="));
    assert(src.includes("const redoFactFidelityHit = checkFactFidelity(reply)"));
    assert(src.includes("const finalFactFidelityHit = checkFactFidelity(reply)"));
    assert(src.includes("function checkUnconsultedSelectedSchedule()"));
    assert(src.includes("const unconsultedSchedule = checkUnconsultedSelectedSchedule()"));
    assert(src.includes("if (o.scheduleVerified)"));
    assert(src.includes("reply = buildContactProgressReply() ?? reply"));
    assert(src.includes("!verdict.pass ? buildContactProgressReply() : null"));
  });
  check("contactPerson skips duplicate open messages across turns", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const repo = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    assert(repo.includes("export async function findRecentOpenCommunication"));
    assert(repo.includes("status in ('queued', 'sent')"));
    assert(repo.includes("responded_at is null"));
    assert(src.includes("const recentlyCovered = new Map"));
    assert(src.includes("await repo.findRecentOpenCommunication"));
    assert(src.includes("这次不重复发送"));
    assert(src.includes("for (const covered of recentlyCovered.values())"));
  });
  check("sent communications retain provider message ids", () => {
    const twilioRoute = readFileSync("app/api/twilio/messages/route.ts", "utf8");
    const cronRoute = readFileSync("app/api/cron/coliving/route.ts", "utf8");
    const deliver = readFileSync("lib/chat/coliving/deliver.ts", "utf8");
    assert(twilioRoute.includes("externalMessageId: sent.ok ? sent.sids.join"));
    assert(deliver.includes("externalMessageId: result.sids.join"));
    assert(cronRoute.includes("externalMessageId: outcome.ok ? outcome.externalMessageId : null"));
  });

  // ── 并发竞态门禁 ────────────────────────────────────────────────────────────
  check("stale-context gate: repo has hasNewInboundSince, turn.ts calls it before send", () => {
    const repo = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    // repo 必须有这个函数
    assert(repo.includes("export async function hasNewInboundSince"));
    assert(repo.includes("m.direction = 'inbound'"));
    assert(repo.includes("m.sent_at > ${since}"));
    // turn.ts 必须在 contacted.add 之前调用它
    assert(src.includes("await repo.hasNewInboundSince("));
    assert(src.includes("turnStartedAt"));
    assert(src.includes("stale: true"));
    // 跳过的消息不能加进 outbound（stale gate 里没有 outbound.push）
    const staleBlock = src.slice(
      src.indexOf("const targetHasNewInbound"),
      src.indexOf("contacted.add(target.personId)")
    );
    assert(!staleBlock.includes("outbound.push"), "stale-skipped message must not enter outbound");
  });

  // ── 自报精确时段不再征询 ────────────────────────────────────────────────────
  check("saidExactSlot schema exists in pickSchedule people and selfStatedSlotsByWindow is tracked", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(src.includes("saidExactSlot"));
    assert(src.includes("selfStatedSlotsByWindow"));
    // 自报时段立即 return skipped:true，不发任何消息（不用通知语气，也不用征询语气）
    assert(src.includes("preConsented: true") && src.includes("skipped: true"), "self-stated slot must return preConsented+skipped");
    // 预同意分支不能调用 queueCommunication
    assert(!src.slice(0, src.indexOf("preConsented: true")).split("if (isSelfStated)").pop()?.includes("queueCommunication"),
      "preConsented branch must not reach queueCommunication");
    // 非自报时段仍走征询
    assert(src.includes("你愿意吗"), "non-self-stated slot still asks for confirmation");
  });
  check("isSimpleAffirmation detects yes-words only, not compound messages", () => {
    assert.equal(isSimpleAffirmation("愿意"), true);
    assert.equal(isSimpleAffirmation("行"), true);
    assert.equal(isSimpleAffirmation("好的"), true);
    assert.equal(isSimpleAffirmation("可以"), true);
    assert.equal(isSimpleAffirmation("没问题"), true);
    assert.equal(isSimpleAffirmation("确认"), true);
    assert.equal(isSimpleAffirmation("OK"), true);
    // 含追问的不算纯肯定
    assert.equal(isSimpleAffirmation("愿意，但为什么我最后用？"), false);
    assert.equal(isSimpleAffirmation("可以，你什么时候确认？"), false);
    assert.equal(isSimpleAffirmation("你好"), false);
    assert.equal(isSimpleAffirmation("我有问题"), false);
  });
  check("isScheduleSlotInquiry recognises slot inquiry by act and body template", () => {
    const slotInquiry = {
      act: "propose" as const,
      body: "小五，关于早晨厨房时段，我先提出一个待确认的安排：你用 07:15-07:25。这不是定案；你愿意吗？如果不合适直接告诉我，我会根据大家的回复继续协调。",
    };
    assert.equal(isScheduleSlotInquiry(slotInquiry), true);
    assert.equal(extractSlotFromInquiry(slotInquiry.body), "07:15-07:25");
    // inform 类型（房东联系）不算征询
    assert.equal(isScheduleSlotInquiry({ act: "inform", body: slotInquiry.body }), false);
    // 没有 act 不算
    assert.equal(isScheduleSlotInquiry({ act: null, body: slotInquiry.body }), false);
    // 普通消息不算
    assert.equal(isScheduleSlotInquiry({ act: "propose", body: "你这边有没有时间？" }), false);
    assert.equal(isScheduleSlotInquiry(null), false);
  });
  check("isScheduleSlotInquiry recognises act=ask (production act value)", () => {
    // 生产日志实测：contactPerson 发出的征询落库为 act='ask'，不是 propose/confirm。
    // 初版只检查 propose/confirm 导致生产场景全部漏识别；这里回归覆盖 ask。
    const askInquiry = { act: "ask" as const, body: "你用 07:15-07:25，愿意吗？" };
    assert.equal(isScheduleSlotInquiry(askInquiry), true);
    assert.equal(extractSlotFromInquiry(askInquiry.body), "07:15-07:25");
    // 非排班内容不触发（act 对，body 错）
    assert.equal(isScheduleSlotInquiry({ act: "ask", body: "今天吃什么？" }), false);
  });
  check("scheduleSlotMatchesSelfStatement: exact match is preconsented, any mismatch is not", () => {
    // 自报时段与选定时段完全相等 → 视为预先同意，不再发征询。
    assert.equal(
      scheduleSlotMatchesSelfStatement({ start: "07:15", end: "07:25" }, { start: "07:15", end: "07:25" }),
      true,
      "完全相同应返回 true"
    );
    // start 不同（算法把开始时间挪晚了）→ 不命中
    assert.equal(
      scheduleSlotMatchesSelfStatement({ start: "07:30", end: "07:40" }, { start: "07:15", end: "07:40" }),
      false,
      "start 不同应返回 false"
    );
    // end 不同（时长被改了）→ 不命中
    assert.equal(
      scheduleSlotMatchesSelfStatement({ start: "07:15", end: "07:25" }, { start: "07:15", end: "07:35" }),
      false,
      "end 不同应返回 false"
    );
    // 没有自报记录（undefined）→ 不命中
    assert.equal(
      scheduleSlotMatchesSelfStatement(undefined, { start: "07:15", end: "07:25" }),
      false,
      "没有自报记录应返回 false"
    );
  });
  check("preconsent branch returns before queueCommunication in contactPerson source", () => {
    // 结构断言：确保 preConsentedForSchedule.add 和 return {preConsented:true, skipped:true}
    // 出现在 queueCommunication 之前，防止预同意分支悄悄走漏到发送流程。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const preconsentIdx = turnSrc.indexOf("preConsentedForSchedule.add(target.personId)");
    // Find the preConsented return block — look for "preConsented: true," which is unique to this branch
    const returnPreconsentedIdx = turnSrc.indexOf("preConsented: true,");
    const queueIdx = turnSrc.indexOf("queueCommunication({");
    assert(preconsentIdx > 0, "preConsentedForSchedule.add 必须存在");
    assert(returnPreconsentedIdx > 0, "preConsented:true return 必须存在");
    // 预同意的 return 必须在 queueCommunication 之前（在源码里 index 更小）
    assert(
      returnPreconsentedIdx < queueIdx,
      `预同意 return（@${returnPreconsentedIdx}）必须早于 queueCommunication（@${queueIdx}）`
    );
  });
  check("simpleScheduleAffirmation guards all buildSelectedScheduleReply overrides", () => {
    // 结构断言：确认三处 buildSelectedScheduleReply 覆盖都加了 !simpleScheduleAffirmation 守护。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const scheduleReplyCalls = [...turnSrc.matchAll(/buildSelectedScheduleReply\(\)/g)];
    // 至少 3 处调用（initial / final / settled）
    assert(scheduleReplyCalls.length >= 3, `期望至少 3 处 buildSelectedScheduleReply() 调用，实际 ${scheduleReplyCalls.length}`);
    // 每个调用点后紧跟的 if 条件都应含 simpleScheduleAffirmation
    const overridePattern = /buildSelectedScheduleReply\(\)[\s\S]{0,120}simpleScheduleAffirmation/g;
    const guarded = [...turnSrc.matchAll(overridePattern)];
    assert(
      guarded.length >= 3,
      `期望至少 3 处 override 被 simpleScheduleAffirmation 守护，实际 ${guarded.length}`
    );
  });
  check("productionContactPerson calls scheduleSlotMatchesSelfStatement (not inline logic)", () => {
    // Fix 1: 生产 contactPerson 必须调用纯函数，不能复制一份内联判断。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(turnSrc.includes("scheduleSlotMatchesSelfStatement(selfStatedEntry, scheduleSlot)"),
      "contactPerson 必须调用 scheduleSlotMatchesSelfStatement 而不是内联三条件");
    // 内联旧写法不应出现（selfStated.start === scheduleSlot.start 直接比较）
    assert(!turnSrc.includes("selfStatedEntry.start === scheduleSlot.start"),
      "不应出现内联 start 比较，应改为调用 scheduleSlotMatchesSelfStatement");
  });
  check("simpleScheduleConfirmationText is applied last before appendMessage/queueCommunication", () => {
    // Fix 2: 短回复确认文本必须在最终收口（入库之前）最后覆盖，防止审稿/重写路径把它改长。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(turnSrc.includes("simpleScheduleConfirmationText"), "必须存在 simpleScheduleConfirmationText 变量");
    // 使用唯一注释定位最终 override 块，以及唯一字符串定位回复 queueCommunication
    const finalOverrideIdx = turnSrc.indexOf("最终落锤：简单肯定覆盖");
    const replyQueueIdx = turnSrc.indexOf('"回复本人"');
    assert(finalOverrideIdx > 0, "最终落锤注释必须存在");
    assert(replyQueueIdx > 0, "回复本人 queueCommunication 必须存在");
    assert(finalOverrideIdx < replyQueueIdx,
      `最终落锤（@${finalOverrideIdx}）必须早于 queueCommunication 回复本人（@${replyQueueIdx}）`);
  });
  check("pendingCommunication orders expects_reply=true first to prevent notification shadowing", () => {
    // Fix 3: 新的通知（expects_reply=false）不能遮住真正的时段征询（expects_reply=true）。
    const repoSrc = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    assert(repoSrc.includes("(expects_reply = true) desc, sent_at desc limit 1"),
      "pendingCommunication 必须优先 expects_reply=true 再按时间排序");
  });
  check("wecom route applies same pre-send race gate as twilio route", () => {
    // Fix 4: WeCom 投递路径必须与 Twilio 语义一致，有 hasNewInboundSince 竞态门禁。
    const wecomSrc = readFileSync("app/api/wecom/messages/route.ts", "utf8");
    assert(wecomSrc.includes("hasNewInboundSince"), "wecom route 必须 import hasNewInboundSince");
    assert(wecomSrc.includes("deliverWithGate"), "wecom route 必须有 deliverWithGate");
    assert(wecomSrc.includes("outcome.turnStartedAt"), "wecom route 必须使用 turnStartedAt");
    assert(wecomSrc.includes('status: "skipped"'), "wecom route 必须 mark skipped");
    // 日志不得打印地址（m.to），只允许 communicationId/personId
    assert(!wecomSrc.includes("已有新入站：\", m.to"), "wecom route 日志不能打印 m.to 地址");
  });
  check("route.ts applies pre-send race gate for outbound messages", () => {
    const routeSrc = readFileSync("app/api/twilio/messages/route.ts", "utf8");
    // 必须 import hasNewInboundSince
    assert(routeSrc.includes("hasNewInboundSince"), "route.ts must import hasNewInboundSince");
    // 必须有竞态门禁逻辑
    assert(routeSrc.includes("deliverWithGate"), "route.ts must have deliverWithGate");
    assert(routeSrc.includes("outcome.turnStartedAt"), "route.ts must use turnStartedAt");
    assert(routeSrc.includes('status: "skipped"'), "route.ts must mark stale outbound as skipped");
    assert(routeSrc.includes("上下文过期"), "route.ts must log the skipped reason");
  });
  check("getRecentTurns excludes skipped outbound from context", () => {
    const repoSrc = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    // 查询必须 left join communication 并过滤 skipped
    assert(repoSrc.includes("left join coliving.communication"), "getRecentTurns must join communication table");
    assert(repoSrc.includes("c.status != 'skipped'"), "getRecentTurns must exclude skipped outbound");
  });
  check("stale-skipped contactPerson outbound does not count as contacted in judge trace", () => {
    // 旧回合跳过的消息不能出现在 outbound 里；judge 不会看到"已联系"
    const turns: JudgeTurn[] = [{
      fromName: "小五",
      said: "愿意",
      reply: "好，你的 07:15-07:25 已经定下来了。",
      outbound: [],  // 竞态门禁触发，这轮没有出站消息
    }];
    // judge 不应该把 outbound 为空本身当成问题：
    // 没有 findings → verified=true, pass=true（"没发现问题"是一个正当的合格结论）
    const r = finalizeJudgment([], turns);
    assert.equal(r.verified, true);
    assert.equal(r.pass, true);
    assert.deepEqual(r.findings, []);
  });
  check("scheduleContactTextForAct: every act returns the inquiry text, never a final notice", () => {
    // act 分支已回退（Codex Sonnet-4.5 全量回归结论）：act 字段不可靠，
    // 常还在征询时就填 inform。任何 act 都必须返回「待确认安排」征询正文。
    const salutation = "老孙，";
    const slot = { start: "17:30", end: "18:00" };
    for (const act of ["inform", "remind", "propose", "confirm", "ask"] as const) {
      const text = scheduleContactTextForAct({ act, salutation, windowLabel: "傍晚厨房灶台时段", scheduleSlot: slot });
      assert(text.includes("你愿意吗") && text.includes("这不是定案"),
        `${act} 也应返回征询正文，不得出定案通知：${text}`);
      assert(text.includes("17:30-18:00"), `${act} 正文应带时段`);
      assert(!text.includes("就这样定了"), `${act} 正文不得含「就这样定了」：${text}`);
    }
  });
  check("contactPerson builds schedule text via scheduleContactTextForAct (no inline duplicate, no act branch)", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(src.includes("scheduleContactTextForAct("), "contactPerson 必须调用 scheduleContactTextForAct");
    // 定案正文分支必须整体不存在（连「就这样定了，有变动随时说。」这句也不能复辟）
    assert(!src.includes("就这样定了，有变动随时说。"),
      "scheduleContactTextForAct 不得再含 inform/remind 定案正文分支");
    const contactCallIdx = src.indexOf("message = scheduleContactTextForAct(");
    assert(contactCallIdx > 0, "contactPerson 的 message 赋值必须来自 scheduleContactTextForAct");
    // 内联征询模板只能在纯函数里以 args.scheduleSlot 出现一次；contactPerson 直接拼
    // 「你用 ${scheduleSlot.start}-…」的旧写法不应再存在。
    assert(src.indexOf("你用 ${scheduleSlot.start}-${scheduleSlot.end}。这不是定案") === -1,
      "contactPerson 不应再内联征询模板");
  });
  check("selected-schedule auto-funnel deterministically enqueues every still-missing participant", () => {
    // 治本（Codex 全量回归实测）：选定多人排班后"逐个向漏掉的人征询到位"由代码
    // 确定性完成，不再靠模型记得逐个 contactPerson——模型单轮里既要 pickSchedule
    // → chooseSchedule → 逐个 contactPerson → sendReply 经常漏人，打回重写仍漏。
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    // 1) 只有一个入队函数定义；contactPerson 排班分支与最终收口都委托它，不复制两份。
    const enqueueDefs = src.match(/async function enqueueScheduleContact\(/g) ?? [];
    assert.equal(enqueueDefs.length, 1, "enqueueScheduleContact 只能定义一次（不允许复制两份发送逻辑）");
    assert(src.includes("return enqueueScheduleContact(name, scheduleWindowLabel, scheduleSlot);"),
      "contactPerson 排班分支必须委托 enqueueScheduleContact");
    assert(src.includes("const message = scheduleContactTextForAct({"),
      "征询正文必须由固定模板 scheduleContactTextForAct 生成（不按模型 act 分支）");
    // 2) 最终收口循环真实存在：遍历 missingSelectedScheduleParticipants() 返回值，
    //    逐个按其在选定方案里的 assignment 调 enqueueScheduleContact。
    const settledIdx = src.indexOf("const settledScheduleReply = buildSelectedScheduleReply()");
    const loopStart = src.indexOf("for (const name of missingSelectedScheduleParticipants())");
    assert(loopStart > 0, "必须存在遍历 missingSelectedScheduleParticipants 的确定性循环");
    assert(loopStart < settledIdx,
      `补发循环（@${loopStart}）必须早于 settled reply（@${settledIdx}），回复才能看到真实出站`);
    const funnelBlock = src.slice(loopStart, settledIdx);
    assert(funnelBlock.includes("await enqueueScheduleContact("),
      "循环必须逐个调 enqueueScheduleContact");
    assert(funnelBlock.includes("selectedWindowLabel"),
      "循环必须把选中方案的 window label 传给入队函数");
    assert(funnelBlock.includes("assignmentSlot"),
      "循环必须按参与者在选定方案里的 assignment slot 调入队函数");
    assert(funnelBlock.includes("if (!assignmentSlot) continue"),
      "名册里没有该名字 assignment 的参与者必须安全跳过");
    // 3) 收口循环不得自己复制发送逻辑——共用 enqueueScheduleContact 才会走全部门禁。
    assert(!funnelBlock.includes("queueCommunication({"), "收口循环不得再直接 queueCommunication");
    assert(!funnelBlock.includes("outbound.push({"), "收口循环不得再直接入 outbound");
  });
  check("durable confirmation: repo exposes responded schedule inquiries, turn skips confirmed slots", () => {
    const repo = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(repo.includes("export async function listScheduleInquiryConfirmations"));
    assert(repo.includes("c.response_message_id"), "必须 join 回复消息确认 responded 状态");
    assert(repo.includes("responded_at is not null"));
    assert(repo.includes("c.act in ('ask', 'propose', 'confirm')"));
    assert(src.includes("await repo.listScheduleInquiryConfirmations(sender.householdId)"));
    assert(src.includes("hasDurableConfirmedSlot("), "contactPerson/门禁必须用持久确认判断");
    assert(src.includes("之前已确认过 ${scheduleSlot.start}-${scheduleSlot.end} 这个时段"), "持久确认的跳过返回必须带明确原因");
    assert(src.includes("preConsentedForSchedule.add(target.personId)"), "持久确认跳过必须计入 preConsented");
  });
  check("scheduleInquiryConfirmation parses yes-only responses to real slot inquiries", () => {
    assert.deepEqual(
      scheduleInquiryConfirmation({
        inquiryBody: "老孙，关于傍晚厨房灶台时段，我先提出一个待确认的安排：你用 17:30-18:00。这不是定案；你愿意吗？",
        responseBody: "愿意",
      }),
      { windowLabel: "傍晚厨房灶台时段", start: "17:30", end: "18:00" }
    );
    // 非简单肯定（追问/拒绝/纯信息）不构成确认
    assert.equal(scheduleInquiryConfirmation({ inquiryBody: "你用 17:30-18:00，愿意吗？", responseBody: "愿意，但为什么我最后用？" }), null);
    assert.equal(scheduleInquiryConfirmation({ inquiryBody: "今天吃什么？", responseBody: "愿意" }), null);
    assert.equal(scheduleInquiryConfirmation({ inquiryBody: "你用 17:30-18:00，愿意吗？", responseBody: "不行" }), null);
  });

  const previous = process.env.COLIVING_JUDGE_OFF;
  process.env.COLIVING_JUDGE_OFF = "1";
  const off = await judgeConversation({ scenarioId: "off", source: "offline", roster: [], turns: bad });
  assert.equal(off.verified, false); assert.equal(off.pass, false); count++;
  if (previous === undefined) delete process.env.COLIVING_JUDGE_OFF;
  else process.env.COLIVING_JUDGE_OFF = previous;
  console.log(`${count} offline checks passed (not a live conversation-quality certification).`);

  const reportIndex = process.argv.indexOf("--report");
  if (process.argv.includes("--judge") || reportIndex >= 0) {
    config({ path: ".env.local", quiet: true } as Parameters<typeof config>[0]);
    config({ path: ".env", quiet: true } as Parameters<typeof config>[0]);
    if (reportIndex >= 0) {
      const reportPath = process.argv[reportIndex + 1];
      assert(reportPath, "--report requires a path");
      // Redact contacts before parsing or transmitting any historical material.
      const redactContacts = (s: string) => s.replace(/\+?\d[\d ()-]{8,}\d/g, (m) => m.replace(/\D/g, "").length >= 10 ? "[已移除联系方式]" : m);
      const redacted = redactContacts(readFileSync(reportPath, "utf8"));
      const records = JSON.parse(redacted) as Array<{ id: string; turns: JudgeTurn[]; [key: string]: unknown }>;
      // This is a re-audit of historical generated text, never a new generation run.
      for (const record of records) {
        const names = [...new Set(record.turns.flatMap((t) => [t.fromName, ...t.outbound.map((o) => o.toName)]))].filter(Boolean);
        let safeTurns = JSON.stringify(record.turns.map(({ fromName, said, reply, outbound }) => ({ fromName, said, reply, outbound: outbound.map(({ toName, text, blocked }) => ({ toName, text, blocked })) })));
        for (const [i, name] of names.sort((a, b) => b.length - a.length).entries()) {
          safeTurns = safeTurns.split(name).join(`参与者${i + 1}`);
        }
        record.turns = JSON.parse(safeTurns);
        assert.equal(redactContacts(safeTurns), safeTurns, "contact redaction failed");
        record.judge = await judgeConversation({ scenarioId: record.id, source: "历史对话重新验收；判断协调是否有效、是否尊重已知限制、联系状态是否如实。不是新版本生成结果。", roster: [], turns: record.turns });
        record.source = "历史对话重新验收（不是新版本生成结果）";
        console.log(JSON.stringify({ id: record.id, judge: record.judge }));
      }
      const output = reportPath.replace(/\.json$/i, "-reaudit.json");
      assert.notEqual(output, reportPath, "input must end in .json");
      writeFileSync(output, JSON.stringify(records, null, 2));
      return;
    }
    const good: JudgeTurn[] = [{
      fromName: "小林", said: "我18点到家，做饭要两小时，另外两位各用半小时。",
      reply: "18点到家不代表一定要18点开始。两小时都放在前面，会让其他人一直等。我建议先让两位各用半小时，再留给你连续两小时；这个顺序还要征求大家同意。我已经分别发出了征求意见的消息，等大家回复再确认。",
      outbound: [
        { toName: "小周", text: "厨房先给你和另一位各留半小时，再给需要久一点的住户连续两小时。你愿意先用吗？", blocked: false },
        { toName: "小陈", text: "厨房先给你和另一位各留半小时，再给需要久一点的住户连续两小时。你愿意先用吗？", blocked: false },
      ],
    }];
    for (const [id, turns, expected] of [["false-completion", bad, false], ["reasonable-proposal", good, true]] as const) {
      const result = await judgeConversation({ scenarioId: id, source: "脱敏离线验收器对照，不是生产重放", roster: [], turns: [...turns] });
      console.log(JSON.stringify({ id, ...result }));
      assert.equal(result.verified, true, `${id}: judge unavailable`);
      assert.equal(result.pass, expected, `${id}: wrong semantic verdict`);
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
