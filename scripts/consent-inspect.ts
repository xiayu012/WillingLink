import { config } from "dotenv";
config({ path: ".env.local" });
process.env.COLIVING_LOCAL_WRITE = "1";
import postgres from "postgres";

/**
 * 共识不变量检查（`pnpm consent:inspect`）—— 确定性，不调模型，几秒钟跑完。
 *
 * 守的是一条规矩：**「同意」是对某一个具体方案的同意，方案一改就作废。**
 *
 * 抄自 DialOp（jlin816/dialop）mediation 的 `_reset_proposal_state()`：
 * 那边只要一个人 reject，所有人的 accept 立刻清空，agent 必须拿新方案
 * 从头征询一轮——共识不能跨方案版本继承，这是结构保证不是提示词提醒。
 *
 * 为什么要有这个脚本：这条不变量的破坏是**静默**的。A 同意十点版、
 * AI 改成十二点版却把 A 算作同意，`closeConsultationIfComplete` 会一路
 * 判成"全票通过、定下来了"，没有任何报错——短信发出去才知道伪造了共识。
 * 用对话去测又不稳定（实测模型多数时候自己会拒绝顺延，测不到边界），
 * 所以在 repo 层钉死。
 */
async function main() {
  const repo = await import("../lib/chat/coliving/repo");
  const sql = postgres(process.env.POSTGRES_URL!, { max: 2 });

  const tag = Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0");
  const { householdId } = await repo.createTestHousehold(`不变量_${Date.now()}`);
  await repo.addResident({ householdId, phone: `+1559${tag}01`, name: "房东", role: "landlord", note: null });
  await repo.addResident({ householdId, phone: `+1559${tag}02`, name: "小周", role: "tenant", note: null });
  await repo.addResident({ householdId, phone: `+1559${tag}03`, name: "小吴", role: "tenant", note: null });
  const members = await repo.getMembers(householdId);
  const pid = (n: string) => members.find((m) => m.name === n)!.personId;

  const agreedOf = async (ruleId: string) => {
    const [r] = await sql<any[]>`
      select (select coalesce(array_agg(p.display_name),'{}')
                from coliving.person p where p.id = any(r.agreed_by)) as names
      from coliving.rule r where r.id = ${ruleId}`;
    return (r.names as string[]).sort();
  };

  let pass = true;
  const check = (label: string, ok: boolean, detail: string) => {
    console.log(`${ok ? "✓" : "✗"} ${label} —— ${detail}`);
    if (!ok) pass = false;
  };

  // 1) v1：小周同意、小吴反对
  const v1 = await repo.saveRule({
    householdId, kind: "quiet_hours",
    statement: "晚上十点以后，共用区域保持安静", agreedBy: [], sourceCaseId: null,
  });
  await repo.recordConsultation({ ruleId: v1.ruleId, personId: pid("小周"), stance: "agreed" });
  await repo.recordConsultation({ ruleId: v1.ruleId, personId: pid("小吴"), stance: "objected" });
  check("v1 建立", (await agreedOf(v1.ruleId)).join()==="小周", `同意=${(await agreedOf(v1.ruleId)).join("、")}`);
  check("v1 不是改方案", v1.revisedFrom === null, `revisedFrom=${v1.revisedFrom}`);

  // 2) v2：改成十二点，**故意**把小周当成还同意（模拟模型顺延旧同意）
  const v2 = await repo.saveRule({
    householdId, kind: "quiet_hours",
    statement: "晚上十二点以后，共用区域保持安静",
    agreedBy: [pid("小周")], sourceCaseId: null,
  });
  const v2Agreed = await agreedOf(v2.ruleId);
  check("v2 认出是改方案", v2.revisedFrom === "晚上十点以后，共用区域保持安静", `revisedFrom=${v2.revisedFrom}`);
  check("v2 清空了顺延过来的同意", v2Agreed.length === 0,
        `传入了小周，实际落库同意=${v2Agreed.join("、") || "空"}`);

  // 3) 收口判定：v2 应当因为没人表态而不能成立
  const closed = await repo.closeConsultationIfComplete(v2.ruleId);
  check("v2 不能直接收口", closed.done === false, `done=${closed.done}`);

  // 4) 同样的 statement 重复调用，不该误伤
  const again = await repo.saveRule({
    householdId, kind: "quiet_hours",
    statement: "晚上十二点以后，共用区域保持安静",
    agreedBy: [pid("小周")], sourceCaseId: null,
  });
  const againAgreed = await agreedOf(again.ruleId);
  check("statement 没变时不清空", againAgreed.join() === "小周",
        `revisedFrom=${again.revisedFrom}，同意=${againAgreed.join("、") || "空"}`);

  console.log(pass ? "\n全部通过" : "\n有失败");
  await sql.end();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
