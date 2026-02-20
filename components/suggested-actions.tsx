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
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  selectedVisibilityType: VisibilityType;
  /** Called when user clicks Post shift (to auto-start voice recording) */
  onVoiceAction?: (action: "post") => void;
};

const suggestedActions = [
  {
    label: "Search shift",
    response: "Give me a clue.",
  },
  {
    label: "Post shift",
    response:
      " ",
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

const actionCardTints = [
  "from-emerald-500/12 to-teal-500/8 dark:from-emerald-500/20 dark:to-teal-500/12",
  "from-violet-500/12 to-purple-500/8 dark:from-violet-500/20 dark:to-purple-500/12",
  "from-amber-500/12 to-orange-500/8 dark:from-amber-500/20 dark:to-orange-500/12",
  "from-sky-500/12 to-blue-500/8 dark:from-sky-500/20 dark:to-blue-500/12",
] as const;

function PureSuggestedActions({
  chatId,
  setMessages,
  onVoiceAction,
}: SuggestedActionsProps) {
  return (
    <div
      className="grid w-full gap-3 sm:gap-4 sm:grid-cols-2"
      data-testid="suggested-actions"
    >
      {suggestedActions.map((action, index) => (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          initial={{ opacity: 0, y: 20 }}
          key={action.label}
          transition={{ delay: 0.05 * index }}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          <Suggestion
            className={[
              "h-auto min-h-[52px] w-full whitespace-normal rounded-2xl border-0 p-4 text-left text-base font-medium shadow-sm",
              "bg-gradient-to-br transition-shadow duration-200",
              "hover:shadow-md active:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/50",
              actionCardTints[index],
            ].join(" ")}
            variant="ghost"
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
              if (action.label === "Post shift") {
                onVoiceAction?.("post");
              }
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
