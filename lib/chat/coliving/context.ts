import "server-only";

import {
  getActiveRules,
  getBlockedComms,
  getCaseParties,
  getCasePositions,
  getCaseShares,
  getMembers,
  getOpenCases,
  getStandalonePositions,
  type Member,
  type OpenCase,
  recentOutbound,
  rosterStatus,
  type Sender,
} from "./repo";

/**
 * Context Builder —— 数据库与 LLM 上下文之间的注意力层。
 *
 *   数据库        = 这栋房子几年的完整事实
 *   Context Builder = 这一轮真正相关的那一点
 *   大脑           = 当前思考
 *
 * **默认只给核心状态**（谁住在这、现行规则、未结的事、说话人是谁）。
 * 历史事件、环境观察、相似判例都不预先塞——模型觉得不够，自己调工具去查
 * （设计稿第九、十点）。这样库可以很丰富，而每轮上下文保持干净。
 */

function describeMember(m: Member, isSelf: boolean): string {
  const role = m.role === "landlord" ? "房东" : m.role === "tenant" ? "租客" : m.role;
  const tag = isSelf ? "（就是现在跟你说话的人）" : "";
  // 占位名逐个标出来。**不要靠在别处写一句「名字带 X 字样的是占位符」**——
  // 占位名格式一改那句话就静默失效（真踩过：AI 把「2号、3号」念进了短信）。
  const placeholder = m.nameConfirmed ? "" : "〔占位名，不是真名，不可念出口〕";
  const notes = m.notes.length ? `：${m.notes.join("；")}` : "";
  return `- ${m.name}${placeholder}（${role}）${tag}${notes}`;
}

export type ColivingContext = {
  text: string;
  members: Member[];
  /** 未结事项的结构化元数据，供路由判断后续轮仍属于哪个情境。 */
  openCases: OpenCase[];
  openCaseIds: string[];
  /**
   * 生成器靠这个判断"该不该问总人数"，批判器也需要同一份数据——
   * 否则批判器只看得到 members 列表里已知的几个名字，会把「名册没收全，
   * 该问总人数」的合法提问，误判成"人数明明知道、何必再问"（第18轮踩过）。
   */
  roster: { declaredSize: number | null; knownCount: number; complete: boolean };
};

export async function buildContext(
  sender: Sender,
  channel = "sms",
  opts: {
    justJoined?: boolean;
    answering?: { purpose: string | null; body: string; sentAt: Date; act?: string | null } | null;
  } = {}
): Promise<ColivingContext> {
  const [
    members,
    rules,
    openCases,
    roster,
    recentRaw,
    standalonePositions,
    blocked,
  ] = await Promise.all([
    getMembers(sender.householdId, channel),
    getActiveRules(sender.householdId),
    getOpenCases(sender.householdId),
    rosterStatus(sender.householdId),
    recentOutbound(sender.householdId),
    getStandalonePositions(sender.householdId),
    getBlockedComms(sender.householdId),
  ]);

  // 每件未结的事都可能记了表态（谁想要什么/拒绝了什么/AI 许过什么承诺）——
  // 这里一次性取出来，铺在下面的「还没了结的事」里，不用模型另外调工具查，
  // 免得它忘了查、进而忘了曾经说过的话（起因见 coliving-world-11.sql）
  const positionsByCase = new Map(
    await Promise.all(
      openCases.map(
        async (c) => [c.id, await getCasePositions(c.id)] as const
      )
    )
  );
  // 同样的道理：受影响的人（不一定表过态）和已经算好的份额，
  // 都在结案时要用到，提前铺开省得模型漏查
  const partiesByCase = new Map(
    await Promise.all(
      openCases.map(async (c) => [c.id, await getCaseParties(c.id)] as const)
    )
  );
  const sharesByCase = new Map(
    await Promise.all(
      openCases.map(async (c) => [c.id, await getCaseShares(c.id)] as const)
    )
  );

  // 查出来是新到旧，展示时倒回正序，读起来才是一条时间线
  const recent = [...recentRaw].reverse();

  const lines: string[] = [];

  // 放最前面：实测放末尾会被忽略，模型会编造具体事实（见 AGENT_LOG）
  lines.push("## ⚠️ 你不知道的事（最高优先级，违反即为严重错误）");
  lines.push(
    "「现行规则」里没写到的、以及下面这些，你一概不知道，不许猜、不许拿常见" +
      "做法当本房规定" +
      (rules.length === 0
        ? "（**这栋房子目前一条规则都没登记**：安静时段、垃圾收运日、访客与宠物、门禁密码一概不知）"
        : "") +
      "：房租金额与到期日 · 押金 · 维修进度 · 任何金额 · " +
      "这房子有几个卫生间/厨房、谁跟谁共用。遇到这些直说要跟房东确认" +
      "（contactPerson），并告诉对方你已经去问了。**宁可说不知道，也不要猜。**"
  );
  lines.push("");

  // 它一直在处理「周四」「这周」「明天」这类说法，却从来不知道今天几号——
  // 实测把「周四姐姐来住」的失效日算成了三个月前。
  //
  // **必须显式转太平洋时区，不能用 getDay()/toTimeString()。**
  // 那两个用的是服务器本地时区；本地开发机恰好设成了太平洋时间所以测不出来，
  // 但 Vercel 函数默认 UTC——错位窗口是太平洋下午5点到午夜这7小时
  // （夏令时 UTC-7），**正好是住户最常发短信的时段**。真实事故：
  // 房东说「垃圾周四收」，AI 回「今天正好是周四」，但太平洋时间其实还是周三，
  // UTC 已经跳到周四了。
  const now = new Date();
  const pacific = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const part = (t: string) => pacific.find((p) => p.type === t)?.value ?? "";
  const weekMap: Record<string, string> = {
    周日: "日", 周一: "一", 周二: "二", 周三: "三",
    周四: "四", 周五: "五", 周六: "六",
  };
  lines.push(
    `## 现在是 ${part("year")}-${part("month")}-${part("day")} ` +
      `星期${weekMap[part("weekday")] ?? part("weekday")} ` +
      `${part("hour")}:${part("minute")}（太平洋时间，真实换算，不是服务器时区）`
  );
  lines.push("");

  lines.push("## 当前渠道");
  lines.push(
    channel === "wecom"
      ? "企业微信。回复短一些，控制在 200 字以内。"
      : "短信（SMS）。中文每 70 字计一条，尽量控制在 140 字符内。"
  );
  lines.push(
    "不发链接、不要求上传文件或注册。**短信不渲染 markdown**：星号、井号会原样" +
      "显示成符号。准则里的加粗和列表是写给你看的排版，别照抄发出去——要强调就把" +
      "话说重，要列几条就直接换行。"
  );
  lines.push(
    "你可以主动联系这屋里的其他人（contactPerson），但那是按流程做的判断，不是" +
      "替代自己做决定——别为收集意见把一件事拆成到处问。"
  );
  lines.push("");

  if (opts.answering) {
    const a = opts.answering;
    lines.push("## 他这句多半是在回你之前问的事");
    lines.push(
      `${a.sentAt.toISOString().slice(5, 16).replace("T", " ")} 你问他：` +
        `${a.body.replace(/\s+/g, " ").slice(0, 70)}`
    );
    lines.push(
      "**当成回答来读，别当成新话题。** 他答了就把答案收好，不要再问一遍。"
    );
    lines.push("");
  }

  if (opts.justJoined) {
    // 只陈述事实。**怎么说是准则的事**（见 tenancy.md〈第一次接触〉），
    // 这里不写"你应该说……"——那样等于用一句随手写的提示压过整份准则。
    lines.push("## 这是你第一次跟这个人说话");
    lines.push(
      "「第一次跟他说话」不等于「他刚搬进来」——我们只是刚拿到号码，他可能已住" +
        "三年。**在他自己说之前，你不知道他住了多久**；关于他目前只知道一个手机号。"
    );
    lines.push("");
  }

  const residents = members.filter((m) => m.resides === true);
  const unknown = members.filter((m) => m.resides === null);
  const others = members.filter((m) => m.resides === false);

  lines.push(`## 名册上的人：${sender.householdLabel}`);
  lines.push(
    `**这是名册，不是这栋房子的全部住户。** 名册上现在有 ${members.length} 个人——` +
      "只代表我们手上有这几个人的联系方式，不代表房子里只住这几个。"
  );
  if (residents.length) {
    lines.push(`确认住在这里的（${residents.length} 人）：`);
    for (const m of residents) {
      lines.push(describeMember(m, m.personId === sender.personId));
    }
  }
  if (unknown.length) {
    lines.push(`**住不住在这里还不知道的（${unknown.length} 人）**：`);
    for (const m of unknown) {
      lines.push(describeMember(m, m.personId === sender.personId));
    }
  }
  if (others.length) {
    lines.push("确认不住在这里的：");
    for (const m of others) {
      lines.push(describeMember(m, m.personId === sender.personId));
    }
  }
  lines.push(
    roster.complete
      ? "**名册已确认完整**，分配共用资源就按上面确认住在这里的人数算。"
      : roster.declaredSize !== null
        ? `**⚠️ 有人说过这屋一共住 ${roster.declaredSize} 人，` +
          `但名册上只有 ${roster.knownCount} 个。** ` +
          `还差 ${roster.declaredSize - roster.knownCount} 个人的号码，问到了就用 addResident 加进来。`
        : "**⚠️ 名册还没确认过完整性。** 分配共用资源之前，" +
          "要么先问一句这屋一共住几个人（**问到了立刻用 confirmRoster 记下来**，" +
          "不记的话下一轮你还会再问一遍），要么在给方案时说清这是按目前知道的人算的。" +
          "**不要笃定地说「三个人分」，除非你真的确认过只有三个人。**"
  );
  lines.push(
    "〔占位名〕是系统编的号不是真名，**任何情况下不许说进消息**——要提到又不知其名，" +
      "用位置或事情指（「另一位」「住楼上那位」），或自然问一句「怎么称呼你」" +
      "（问到用 renamePerson 记）。**不得向一位住户披露另一位的工作/收入/身份/" +
      "健康/投诉/欠租等私事**——资料给你判断用，不外传。"
  );
  lines.push("");

  if (sender.role === "landlord") {
    lines.push("## 注意：现在跟你说话的是房东");
    lines.push(
      "房东是房子的所有者，不是你的上级裁判——日常管理是你的职责。" +
        "其指令若涉及歧视、报复、非法驱逐、擅自进入、以身份要挟，走三级拒绝链条。"
    );
    lines.push("");
  }

  lines.push("## 这栋房子的现行规则");
  if (rules.length === 0) {
    lines.push(
      "（空）还没有任何成文规则——这不是等填的表格，是靠问出来的。" +
        "碰到相关的事顺势问一句（一次一个问题），答案用 proposeRule / remember 记。" +
        "这些是住在这里的人共同的事，不是房东规定、也不是你一个人定的。"
    );
  } else {
    for (const r of rules) {
      // **结论由代码给，不让模型自己数人头。** 它拿名单去减人会算错，
      // 而且每一轮都要重算——确定性的账不该进提示词。
      let state: string;
      if (r.pendingNames.length === 0) {
        state =
          r.objectedCount > 0
            ? `**都表过态了**（同意 ${r.agreedCount}，有异议 ${r.objectedCount}）—— 有异议就调整后再走一遍`
            : `**都表过态了，${r.agreedCount} 位都同意，这条已经定下来了。别再问了。**`;
      } else {
        state =
          `同意 ${r.agreedCount}${r.objectedCount ? `，异议 ${r.objectedCount}` : ""}，` +
          `**还差 ${r.pendingNames.length} 位没表态：${r.pendingNames.join("、")}**`;
      }
      lines.push(`- [${r.kind}] ${r.statement}
  → ${state}（id: ${r.id}）`);
    }
    lines.push(
      "还差人没表态的：先照它执行，只问没表态的几位（表过态的别再问），答复用 " +
        "recordStance 记。**老规则必须带上边括号里的 id**——不带 id 只对本轮刚用 " +
        "proposeRule 提的规则有效，对着老规则会静默失败。"
    );
  }
  lines.push("");

  // **在等谁回话**——放在「还没了结的事」前面，因为它比案子列表更可行动：
  // 案子告诉你"有这么件事"，这份清单告诉你"这件事此刻卡在谁身上"。
  // 这两天反复出的"说了跟进却没下文""同一个问题问两遍"，根子就是
  // 以前从来没有这份清单（见 coliving-world-15.sql）。
  if (blocked.length) {
    lines.push("## 你在等谁回话");
    lines.push(
      "这些是你问出去、明确要对方回、还没等到的。开口前先看：别重复问" +
        "同一个人同一件事，也别把已在等的事当成还没做。"
    );
    for (const b of blocked) {
      const waited =
        b.waitedHours < 1
          ? "刚发出去不到一小时"
          : b.waitedHours < 24
            ? `等了 ${b.waitedHours} 小时`
            : `等了 ${Math.floor(b.waitedHours / 24)} 天`;
      const flag = b.overdue ? "**⚠️ 已超过合理等待** " : "";
      const about = b.caseTitle ? `〔${b.caseTitle}〕` : "";
      lines.push(
        `- ${flag}在等 ${b.toName} 回：${about}${b.purpose ?? b.body.slice(0, 40)}（${waited}）`
      );
    }
    lines.push(
      "标了超时的可以再提一次（act 填 remind）或换个不靠他回话的办法往前推，" +
        "别就这么挂着不管。"
    );
    lines.push("");
  }

  lines.push("## 还没了结的事");
  if (openCases.length === 0) {
    lines.push("（空）目前没有在跟进的事。");
  } else {
    for (const c of openCases) {
      lines.push(
        `- ${c.title}（${c.kind}，${c.status}${c.severity ? `，${c.severity}` : ""}，` +
          `最近动静 ${c.lastActivityAt.toISOString().slice(0, 10)}）id=${c.id}`
      );
      const positions = positionsByCase.get(c.id) ?? [];
      for (const p of positions) {
        const kindLabel =
          p.kind === "preference" ? "想要" : p.kind === "rejection" ? "拒绝" : "你许过";
        const accounted = p.honored === null ? "" : p.honored ? "（已满足）" : "（未满足）";
        lines.push(`    · ${p.personName}${kindLabel}：${p.statement}${accounted}`);
      }
      const parties = partiesByCase.get(c.id) ?? [];
      if (parties.length) {
        const names = parties.map(
          (p) => `${p.personName}${p.notified ? "（已通知结果）" : ""}`
        );
        lines.push(`    · 影响到：${names.join("、")}`);
      }
      const shares = sharesByCase.get(c.id) ?? [];
      if (shares.length) {
        const byResource = new Map<string, typeof shares>();
        for (const s of shares) {
          const arr = byResource.get(s.resource) ?? [];
          arr.push(s);
          byResource.set(s.resource, arr);
        }
        for (const [resource, rows] of byResource) {
          const parts = rows.map(
            (s) => `${s.personName} ${s.amount}${s.unit}${s.rationale ? `（${s.rationale}）` : ""}`
          );
          lines.push(`    · 已算好「${resource}」：${parts.join("；")}`);
        }
      }
    }
    lines.push(
      "这一轮是上面某件事的后续就用它的 id，别另开一件。上面缩进的是已记过的" +
        "表态/受影响的人/算好的份额——开新方案先看一眼，别跟自己说过的话对不上、" +
        "别重算份额；新的表态用 recordPosition、新受影响的人用 notePartyAffected、" +
        "份额用 recordShare 记，别只留在本轮对话里。"
    );
  }
  lines.push("");

  if (standalonePositions.length) {
    lines.push("## 还没归到具体事情上的表态");
    lines.push(
      "有人随口提过、当时没立案的偏好/态度（没有 case id）。" +
        "**开新方案、判断谁的时段偏好前先看这里**，别重新去问已经说过的人——" +
        "真实事故：房东早说过「七点用厨房最合适」，排班时模型却说还没确认。"
    );
    for (const p of standalonePositions) {
      const kindLabel =
        p.kind === "preference" ? "想要" : p.kind === "rejection" ? "拒绝" : "你许过";
      lines.push(`- ${p.personName}${kindLabel}：${p.statement}`);
    }
    lines.push("");
  }

  if (recent.length) {
    lines.push("## 你最近跟这屋里的人说过什么（含发给别人的）");
    lines.push("已经问过的别再问一遍，已经答过你的别当没答。");
    // recentOutbound 只返回出站消息——入站由各自会话线的 history 管。
    for (const r of recent) {
      const t = r.sentAt.toISOString().slice(11, 16);
      lines.push(`- ${t} 你对 ${r.to} 说：${r.body.replace(/\n/g, " ").slice(0, 60)}`);
    }
    lines.push("");
  }

  return {
    text: lines.join("\n"),
    members,
    openCases,
    openCaseIds: openCases.map((c) => c.id),
    roster,
  };
}
