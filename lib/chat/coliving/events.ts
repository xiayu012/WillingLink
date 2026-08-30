import "server-only";

/**
 * 事件日志。**临时放内存**，等状态库落地就换成 `event` 表。
 *
 * 存在的意义不是"记一笔"，而是让 `情境_05` 里那条硬要求可被检验：
 * **未行动也要留痕——判断为「无需处理」本身是一个决定，须记录判断依据。**
 */

export type Severity = "P0" | "P1" | "P2" | "P3";

export type ColivingEvent = {
  at: number;
  fromPhone: string;
  fromName: string;
  kind: "message" | "logged" | "notified" | "no-action";
  severity?: Severity;
  summary: string;
  detail?: string;
  /** 命中的准则模块，便于排查是不是路由错了 */
  modules?: string[];
};

const events: ColivingEvent[] = [];
const MAX = 500;

export function recordEvent(e: Omit<ColivingEvent, "at">): void {
  events.push({ ...e, at: Date.now() });
  if (events.length > MAX) {
    events.splice(0, events.length - MAX);
  }
  console.log(
    "[coliving:event]",
    JSON.stringify({
      kind: e.kind,
      severity: e.severity,
      from: e.fromName || e.fromPhone,
      summary: e.summary.slice(0, 120),
      modules: e.modules,
    })
  );
}

export function listEvents(limit = 50): ColivingEvent[] {
  return events.slice(-limit).reverse();
}

export function clearEvents(): void {
  events.length = 0;
}
