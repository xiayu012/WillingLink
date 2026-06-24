import { motion } from "framer-motion";

export const Greeting = () => {
  return (
    <div
      className="mx-auto mt-4 flex size-full max-w-3xl flex-col justify-center px-4 md:mt-16 md:px-8"
      key="overview"
    >
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="font-semibold text-xl md:text-2xl"
        exit={{ opacity: 0, y: 10 }}
        initial={{ opacity: 0, y: 10 }}
        transition={{ delay: 0.5 }}
      >
        You can type to chat with me. Try asking about housing anywhere in
        the California Bay Area—for example: &ldquo;Are there any places under
        $5,000 in San Jose? I live alone.&rdquo;
      </motion.div>
    </div>
  );
};
