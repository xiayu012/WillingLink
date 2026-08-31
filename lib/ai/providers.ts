import { gateway } from "@ai-sdk/gateway";
import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { isTestEnvironment } from "../constants";
import { DEFAULT_CHAT_MODEL } from "./models";

const THINKING_SUFFIX_REGEX = /-thinking$/;

export const myProvider = isTestEnvironment
  ? (() => {
      const {
        chatModel,
        reasoningModel,
        titleModel,
      } = require("./models.mock");
      return customProvider({
        languageModels: {
          "chat-model": chatModel,
          "chat-model-reasoning": reasoningModel,
          "title-model": titleModel,
        },
      });
    })()
  : null;

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  const isReasoningModel =
    modelId.includes("reasoning") || modelId.endsWith("-thinking");

  if (isReasoningModel) {
    const gatewayModelId = modelId.replace(THINKING_SUFFIX_REGEX, "");

    return wrapLanguageModel({
      model: gateway.languageModel(gatewayModelId),
      middleware: extractReasoningMiddleware({ tagName: "thinking" }),
    });
  }

  return gateway.languageModel(modelId);
}

/**
 * 向量模型。目前只有合租房的判例/资料检索在用。
 * 维度与 `coliving.*.embedding` 列的 `vector(1536)` 绑定——换模型要一起改。
 */
export function getEmbeddingModel(modelId: string) {
  return gateway.textEmbeddingModel(modelId);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return gateway.languageModel("anthropic/claude-haiku-4.5");
}

export function getFeedTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return gateway.languageModel("openai/gpt-4o-mini");
}

/**
 * 搜索终审（verify-listings）。
 *
 * 历史：haiku 稳定臆造用户属性（把候选帖里的"无宠物"反向脑补成"用户有猫"
 * 去剔除），所以曾锁死 sonnet-4.5。2026-08-16 用户要求换成项目默认的
 * gpt-4.1-mini（成本 + 与聊天层统一）。**这是判断密集型任务，换模型必须跑
 * `pnpm search-eval -- --source wanted --limit 181` 并确认 CODE_BUG=0**；
 * 若发现剔除理由开始臆造用户属性，第一嫌疑就是这里，改回 sonnet 即可。
 */
export function getVerifierModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return gateway.languageModel(DEFAULT_CHAT_MODEL);
}

/**
 * 查询理解层（lib/rental/query-plan.ts）。**每次搜索都会调用一次**，所以
 * 要的是便宜+快+听话，不是最聪明——任务是把已经说出口的需求抄进 JSON，
 * 不需要推理。gpt-4.1-mini 与聊天层同源，行为可预期。
 *
 * 换模型必须跑 `pnpm search-eval -- --source wanted --limit 181`（CODE_BUG=0）
 * 和 `pnpm search-recall-eval`（recall 不下降）。理解层退化的典型表现是
 * "库里明明有却说没有"——那是 recall 评测在看的东西，普通门禁看不见。
 */
export function getQueryPlannerModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return gateway.languageModel(DEFAULT_CHAT_MODEL);
}
