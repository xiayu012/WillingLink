"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

type GuideStep = {
  id: string;
  title: string;
  instruction: string;
  targetLabel: string;
  suggestion: string;
};

const STEPS: GuideStep[] = [
  {
    id: "open-create-post",
    title: "打开发帖入口",
    instruction: "请点击左侧平台菜单中的「Create Post」。",
    targetLabel: "Create Post 按钮",
    suggestion: "先用品牌名+活动词做开场，提升首屏识别。",
  },
  {
    id: "fill-title",
    title: "填写标题",
    instruction: "将 AI 建议标题复制到标题输入框，再按你的语气微调。",
    targetLabel: "Title 输入框",
    suggestion: "标题建议：湾区租房避坑清单：3步找到靠谱房东",
  },
  {
    id: "fill-caption",
    title: "完善正文",
    instruction: "把正文模板粘贴后，补充你这次活动的具体时间与利益点。",
    targetLabel: "Caption 文本框",
    suggestion: "正文建议：先说痛点，再给方法，最后加明确 CTA。",
  },
  {
    id: "review-and-publish",
    title: "人工复核并发布",
    instruction: "确认账号、分组和可见性后，手动点击发布按钮。",
    targetLabel: "Publish 按钮",
    suggestion: "发布前检查：手机号/链接/时间是否准确。",
  },
];

function StepCard({
  step,
  isActive,
  index,
}: {
  step: GuideStep;
  isActive: boolean;
  index: number;
}) {
  return (
    <div
      className={`rounded-xl border p-3 transition ${
        isActive ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30" : "border-border bg-background"
      }`}
    >
      <p className="text-xs text-muted-foreground">Step {index + 1}</p>
      <p className="font-medium text-sm">{step.title}</p>
      <p className="mt-1 text-muted-foreground text-xs">{step.instruction}</p>
    </div>
  );
}

function HighlightBox({
  label,
  active,
  className,
}: {
  label: string;
  active: boolean;
  className: string;
}) {
  return (
    <div
      className={`${className} relative rounded-lg border transition ${
        active ? "border-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,0.25)]" : "border-border"
      }`}
    >
      <div className="absolute -top-3 left-3 rounded bg-blue-600 px-2 py-0.5 text-[10px] text-white">
        {label}
      </div>
    </div>
  );
}

export default function OpsCopilotDemoPage() {
  const [stepIndex, setStepIndex] = useState(0);

  const step = STEPS[stepIndex];

  const titleSuggestion = useMemo(() => {
    return `【${step.targetLabel}】${step.suggestion}`;
  }, [step]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-6">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-xl">Ops Copilot Demo</h1>
          <p className="text-muted-foreground text-sm">
            人机协同演示：AI 负责提示与建议，关键动作由你手动确认执行。
          </p>
        </div>
        <Link className="text-sm underline hover:text-foreground" href="/">
          返回首页
        </Link>
      </header>

      <div className="grid flex-1 gap-4 md:grid-cols-[320px_1fr]">
        <aside className="rounded-2xl border bg-background p-4">
          <p className="mb-2 font-medium text-sm">操作步骤</p>
          <div className="space-y-2">
            {STEPS.map((item, index) => (
              <StepCard index={index} isActive={index === stepIndex} key={item.id} step={item} />
            ))}
          </div>

          <div className="mt-4 rounded-xl border bg-muted/40 p-3">
            <p className="font-medium text-sm">AI 建议</p>
            <p className="mt-1 text-sm">{titleSuggestion}</p>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              className="rounded border px-3 py-2 text-sm disabled:opacity-40"
              disabled={stepIndex === 0}
              onClick={() => setStepIndex((prev) => Math.max(0, prev - 1))}
              type="button"
            >
              上一步
            </button>
            <button
              className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-40"
              disabled={stepIndex === STEPS.length - 1}
              onClick={() => setStepIndex((prev) => Math.min(STEPS.length - 1, prev + 1))}
              type="button"
            >
              下一步
            </button>
          </div>
        </aside>

        <main className="rounded-2xl border bg-background p-4">
          <p className="mb-3 font-medium text-sm">模拟平台发布界面</p>
          <div className="grid gap-3 md:grid-cols-[220px_1fr]">
            <div className="space-y-3">
              <HighlightBox
                active={step.id === "open-create-post"}
                className="h-14 p-3"
                label="Create Post 按钮"
              />
              <div className="rounded-lg border p-3 text-muted-foreground text-xs">
                这里只是演示区，你后续可以把它替换成真实业务 iframe 或内嵌页面。
              </div>
            </div>
            <div className="space-y-3">
              <HighlightBox
                active={step.id === "fill-title"}
                className="h-16 p-3"
                label="Title 输入框"
              />
              <HighlightBox
                active={step.id === "fill-caption"}
                className="h-28 p-3"
                label="Caption 文本框"
              />
              <HighlightBox
                active={step.id === "review-and-publish"}
                className="h-14 p-3"
                label="Publish 按钮"
              />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
