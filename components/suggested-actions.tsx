"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { motion } from "framer-motion";
import { memo } from "react";
import type { ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";
import { Suggestion } from "./elements/suggestion";
import type { VisibilityType } from "./visibility-selector";

type SuggestedActionsProps = {
  chatId: string;
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  selectedVisibilityType: VisibilityType;
};

const suggestedActions = [
  {
    label: "Search shift",
    response: "Just tell me what you're looking for.",
  },
  {
    label: "Post shift",
    response:
      "Talk to members about the shift you want to post.\n\nYou can share things like:\n\n- **What to do**\n- **Start time**\n- **Where**\n- **Skills needed**\n- **People this helped**\n- **Labor credits (hours)**",
  },
  {
    label: "Download labor records of Twin Oaks",
    response: "Downloading.",
  },
  {
    label: "Feedback to WillingLink",
    response: "Tell something to WillingLink developers.",
  },
];

function PureSuggestedActions({
  chatId,
  setMessages,
}: SuggestedActionsProps) {
  return (
    <div
      className="grid w-full gap-2 sm:grid-cols-2"
      data-testid="suggested-actions"
    >
      {suggestedActions.map((action, index) => (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          initial={{ opacity: 0, y: 20 }}
          key={action.label}
          transition={{ delay: 0.05 * index }}
        >
          <Suggestion
            className="h-auto w-full whitespace-normal p-3 text-left"
            onClick={() => {
              window.history.pushState({}, "", `/chat/${chatId}`);
              setMessages([
                {
                  id: generateUUID(),
                  role: "user",
                  parts: [{ type: "text", text: action.label }],
                },
                {
                  id: generateUUID(),
                  role: "assistant",
                  parts: [{ type: "text", text: action.response }],
                },
              ]);
            }}
            suggestion={action.label}
          >
            {action.label}
          </Suggestion>
        </motion.div>
      ))}
    </div>
  );
}

export const SuggestedActions = memo(
  PureSuggestedActions,
  (prevProps, nextProps) => {
    if (prevProps.chatId !== nextProps.chatId) {
      return false;
    }
    if (prevProps.selectedVisibilityType !== nextProps.selectedVisibilityType) {
      return false;
    }

    return true;
  }
);
