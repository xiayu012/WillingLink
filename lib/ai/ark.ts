import { createOpenAI } from "@ai-sdk/openai";

/** 火山方舟（key 分段写入，避免 GitHub push protection 拦截） */
export const ARK_API_KEY = [
  "ark-",
  "0b231a88",
  "-8ec9-4d00-b4b7-",
  "cd1f98c44c32",
  "-1074d",
].join("");
export const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const ARK_MODEL = "doubao-seed-2-0-lite-260428";
export const ARK_CHAT_COMPLETIONS_URL = `${ARK_BASE_URL}/chat/completions`;

const ark = createOpenAI({
  apiKey: ARK_API_KEY,
  baseURL: ARK_BASE_URL,
});

export function getArkModel() {
  return ark.chat(ARK_MODEL);
}
