import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Brain, DoctrineModule } from "./types";

/**
 * doctrine 文件读取。仅服务端可用。
 *
 * 为什么用 fs 而不是把内容写进 .ts：
 * 这些准则会被频繁编辑（改行为 = 改一个 markdown 文件，这是本设计的主要优势），
 * markdown 的编辑体验明显好于模板字符串，且不受反引号转义困扰。
 *
 * Vercel 部署需要在 next.config.ts 的 outputFileTracingIncludes 里包含
 * lib/ai/brains/**\/doctrine/*.md，否则文件不会被打进产物。
 */

const cache = new Map<string, string>();

export function readDoctrine(brain: Brain, mod: DoctrineModule): string {
  const key = `${brain.id}:${mod.id}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const path = join(brain.doctrineDir, mod.file);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(
      `[brains] 读不到 doctrine 文件：${path}（大脑 ${brain.id} / 模块 ${mod.id}）`,
      { cause }
    );
  }

  cache.set(key, text);
  return text;
}

/** 开发时热更新用：清掉缓存，下次读取重新落盘内容 */
export function clearDoctrineCache(): void {
  cache.clear();
}
