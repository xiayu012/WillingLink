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
  hasDeferredCoordination,
  isLowInformationFollowUp,
  isOpenConflictCase,
  isPrematureCapacityEscape,
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
