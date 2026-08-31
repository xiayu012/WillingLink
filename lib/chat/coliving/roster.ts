import "server-only";

/**
 * 住户名册。**临时方案**，等状态库落地就换成数据库。
 *
 * 放在环境变量而不是代码里，是因为里面是真实手机号——不该进 git。
 * 格式（JSON 数组，写在 `COLIVING_ROSTER` 里）：
 *
 *   [{"phone":"+15551230001","name":"小李","role":"tenant","note":"上夜班，白天睡觉"},
 *    {"phone":"+15551230002","name":"小王","role":"tenant"},
 *    {"phone":"+15551230003","name":"张房东","role":"landlord"}]
 *
 * `note` 是自由文本，会原样进提示词——用来放作息、语言偏好、在意的事，
 * 也就是 `情境_03` 里入住时该问的那八个问题的答案。
 */

export type Role = "tenant" | "landlord";

export type Person = {
  phone: string;
  name: string;
  role: Role;
  note?: string;
};

/** 把各种写法统一成 E.164：5551230001 / (555) 123-0001 / +1 555 123 0001 → +15551230001 */
export function normalizePhone(raw: string): string {
  const digits = (raw || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    return digits;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return digits ? `+${digits}` : "";
}

let cached: Person[] | null = null;

export function getRoster(): Person[] {
  if (cached) {
    return cached;
  }
  const raw = process.env.COLIVING_ROSTER?.trim();
  if (!raw) {
    cached = [];
    return cached;
  }
  try {
    const parsed = JSON.parse(raw) as Array<Person & { role: string }>;
    cached = parsed.map((p) => ({
      ...p,
      phone: normalizePhone(p.phone),
      // 兼容旧写法：房东以前叫 manager。真正的「管理员」是本系统自己，
      // 房东就是房东，所以角色名改成了 landlord。
      role: (p.role === "manager" ? "landlord" : p.role) as Role,
    }));
  } catch (e) {
    console.log(
      "[coliving] COLIVING_ROSTER 解析失败，按空名册运行：",
      e instanceof Error ? e.message : String(e)
    );
    cached = [];
  }
  return cached;
}

/** 仅测试用 */
export function resetRosterCache(): void {
  cached = null;
}

export function findPerson(phone: string): Person | undefined {
  const target = normalizePhone(phone);
  return getRoster().find((p) => p.phone === target);
}

export function getLandlords(): Person[] {
  return getRoster().filter((p) => p.role === "landlord");
}

export function getTenants(): Person[] {
  return getRoster().filter((p) => p.role === "tenant");
}

/**
 * 组装这一轮的运行时状态。
 *
 * **关键**：说话人是租客还是房东，决定了准则里一大半的行为分支
 * （房东下达不当指令要走拒绝链条；租客的隐私不能对另一个租客披露）。
 * 所以身份必须进提示词，而且要写清楚未知的情况怎么办。
 */
export function buildRuntimeContext(fromPhone: string): string {
  const me = findPerson(fromPhone);
  const lines: string[] = [];

  // 放最前面：实测发现放末尾会被忽略，模型会编造"垃圾周五晚上倒"这类具体事实
  lines.push("## ⚠️ 你不知道的事（最高优先级，违反即为严重错误）");
  lines.push(
    "本系统目前**没有接入任何房屋数据**。以下事项你一概不知道，" +
      "**绝不允许给出具体答案、绝不允许推测、绝不允许拿常见做法当本房规定**："
  );
  lines.push(
    "垃圾收运日 · 安静时段的具体钟点 · 房租金额与到期日 · 押金规则 · 水电分摊方式 · " +
      "访客与宠物规定 · 门禁密码 · 维修进度 · 谁住几号房 · 任何数字、日期、金额"
  );
  lines.push(
    "遇到这些：直说你需要跟房东确认，用 notifyLandlord 转交，" +
      "并告诉对方你已经转交、会拿到答复后回来说。**宁可说不知道，也不要猜。**"
  );
  lines.push("");

  lines.push("## 当前渠道");
  lines.push("短信（SMS）。回复必须短：中文每 70 字符计一条，尽量控制在 140 字符内。");
  lines.push("不发链接、不要求上传文件或注册、不用 markdown 语法（短信不渲染）。");
  lines.push("");

  lines.push("## 你在跟谁说话");
  if (me) {
    lines.push(
      `${me.name}（${me.role === "landlord" ? "**房东**" : "租客"}）${me.note ? `。${me.note}` : ""}`
    );
    if (me.role === "landlord") {
      lines.push(
        "对方是房东（房子的所有者），不是你的上级裁判——日常管理是你的职责。" +
          "其指令若涉及歧视、报复、非法驱逐、擅自进入、以身份要挟等，走三级拒绝链条。"
      );
    }
  } else {
    lines.push(
      `未知号码 ${fromPhone}。不确认对方身份，不透露任何住户信息，先弄清对方是谁、找哪一户。`
    );
  }
  lines.push("");

  const others = getRoster().filter((p) => p.phone !== normalizePhone(fromPhone));
  if (others.length) {
    lines.push("## 这栋房子里的其他人（仅供你判断，不得向对方披露他人细节）");
    for (const p of others) {
      lines.push(
        `- ${p.name}（${p.role === "landlord" ? "房东" : "租客"}）${p.note ? `：${p.note}` : ""}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
