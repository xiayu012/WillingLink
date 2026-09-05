import "server-only";

import {
  getActiveRules,
  getCaseParties,
  getCasePositions,
  getCaseShares,
  getMembers,
  getOpenCases,
  getStandalonePositions,
  rosterStatus,
  type Member,
  recentOutbound,
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
    answering?: { purpose: string | null; body: string; sentAt: Date } | null;
  } = {}
): Promise<ColivingContext> {
  const [members, rules, openCases, roster, recentRaw, standalonePositions] =
    await Promise.all([
      getMembers(sender.householdId, channel),
      getActiveRules(sender.householdId),
      getOpenCases(sender.householdId),
      rosterStatus(sender.householdId),
      recentOutbound(sender.householdId),
      getStandalonePositions(sender.householdId),
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
  if (rules.length === 0) {
    lines.push(
      "**这栋房子目前一条规则都没有登记。** 安静时段、垃圾收运日、访客与宠物规定、" +
        "水电分摊方式、门禁密码——这些你一概不知道。"
    );
  } else {
    lines.push(
      "下面「现行规则」里**没有写到的**事项，你一概不知道，" +
        "不许猜、不许拿常见做法当本房规定。"
    );
  }
  lines.push(
    "此外你始终不知道：房租金额与到期日 · 押金规则 · 维修进度 · 任何金额 · " +
      "这房子有几个卫生间几个厨房、谁跟谁共用同一个。"
  );
  lines.push(
    "遇到这些：直说要跟房东确认，用 contactPerson 联系房东，" +
      "并告诉对方你已经去问了。**宁可说不知道，也不要猜。**"
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
      : "短信（SMS）。回复必须短：中文每 70 字符计一条，尽量控制在 140 字符内。"
  );
  lines.push(
    "不发链接、不要求上传文件或注册。**短信不渲染 markdown**：" +
      "星号、井号、反引号会原样显示成符号，看着像乱码。"
  );
  lines.push(
    "准则正文里用了大量 ** 加粗和 - 列表，**那是写给你看的排版，不是让你照着发**。" +
      "发出去的短信是纯文本：要强调就把话说重，要列几条就直接换行写。"
  );
  lines.push(
    "**你现在可以主动联系这栋房子里的其他人**（contactPerson）。" +
      "但那是你按流程做的判断，不是拿来替代自己做决定的——" +
      "不要为了收集意见就把一件事拆成到处问。"
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
      "**「第一次跟他说话」不等于「他刚搬进来」。** 我们只是刚拿到他的号码——" +
        "他可能已经在这儿住了三年。**在他自己说之前，你不知道他住了多久。**"
    );
    lines.push("关于他你目前只知道一个手机号。名字是系统占位符，不是真名。");
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
    "标了〔占位名〕的是**系统编的号，不是这个人的名字**。" +
      "**任何情况下都不许把它说进消息里**——住户看到「2号」「3号」" +
      "会觉得自己在被编号管理。要提到那个人又不知道他叫什么，" +
      "就用位置或事情来指（「另一位」「住楼上那位」「跟你反映噪音的那位」）。"
  );
  lines.push(
    "**需要称呼他本人却不知道名字时，直接问一句就行**——" +
      "「怎么称呼你」是自然的，不是审问。问到了用 renamePerson 记下来。"
  );
  lines.push(
    "**不得向一位住户披露另一位的私事**（工作、收入、身份、健康、投诉记录、欠租）。" +
      "上面这些资料是给你判断用的。"
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
      "（空）还没有任何成文规则——**这不是等着谁来填的表格，是要靠问出来的。**"
    );
    lines.push(
      "碰到相关的事就顺势问一句（一次一个问题），把答案用 proposeRule / " +
        "remember 记进来。安静时段、垃圾谁倒、访客怎么算——" +
        "**这些是住在这里的人共同的事，不是房东规定的，也不是你一个人定的。**"
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
      "还差人没表态的：先照它执行，去问还没表态的那几位（只问他们，" +
        "已经表过态的不要再问），拿到答复用 recordStance 记下来。\n" +
        "**这条规则不是这一轮提的，recordStance 要带上上面括号里那个 id**" +
        "（不带 id 只在同一轮刚用 proposeRule 提的规则上才能用，" +
        "对着一条老规则调不带 id 的 recordStance 会静默失败——" +
        "有人反悔、有人补表态，都是对着老规则，**必须带 id**）。"
    );
  }
  lines.push("");

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
      "**这一轮的话如果是上面某件事的后续，用它的 id，不要另开一件。**"
    );
    lines.push(
      "**上面缩进列出的是已经记录过的表态（谁想要什么/拒绝了什么/你许过什么承诺）、" +
        "被影响到的人、以及已经算好的份额。** 开新方案前先看一眼，别跟自己或别人" +
        "说过的话对不上、别重新心算一遍份额；有新的表态用 recordPosition 记，" +
        "有新的受影响的人用 notePartyAffected 记，算好份额用 recordShare 记，" +
        "别只放在这轮对话里。"
    );
  }
  lines.push("");

  if (standalonePositions.length) {
    lines.push("## 还没归到具体事情上的表态");
    lines.push(
      "**这些是有人随口提到的偏好/态度，当时还没有对应的「未结的事」，" +
        "所以没有 case id。** 真实事故：房东随口说过「七点用厨房最合适」，" +
        "那时候没有冲突浮现，几轮之后真的要排班时，模型却说「你的时间" +
        "还没确认」——房东早说过了，只是没被结构化记住，靠对话记录" +
        "自己找就漏了。**开新方案、判断谁的时段偏好之前，先看这里**，" +
        "别重新去问已经说过的人。"
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
    lines.push(
      "**看清楚再开口。** 已经问过的别再问一遍，已经答过你的别当没答。"
    );
    for (const r of recent) {
      const t = r.sentAt.toISOString().slice(11, 16);
      const who = r.direction === "inbound" ? `${r.to} 说` : `你对 ${r.to} 说`;
      lines.push(`- ${t} ${who}：${r.body.replace(/\n/g, " ").slice(0, 60)}`);
    }
    lines.push("");
  }

  lines.push("## 你还能查什么（默认没给你，需要才查）");
  lines.push(
    "- lookupHistory：这个人或这类事过去发生过什么" +
      "（判断是首次还是反复，直接决定处理力度）"
  );
  lines.push("- findSimilarCases：这栋房子以前类似的事最后怎么收场的");
  lines.push(
    "- checkEnvironment：投诉的时间点附近，房子周边有没有外部噪音/气味来源" +
      "——**不是所有抱怨都该归咎于室友**"
  );

  return {
    text: lines.join("\n"),
    members,
    openCaseIds: openCases.map((c) => c.id),
    roster,
  };
}
