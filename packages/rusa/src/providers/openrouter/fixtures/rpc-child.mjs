// Synthetic peer only. No Pi imports, credentials, network or model requests.
import { createInterface } from "node:readline";

const mode = process.argv[2];
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const lines = createInterface({ input: process.stdin });
// Remain alive after settlement so the host must perform cleanup.
setInterval(() => {}, 1000);
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (mode === "stall") return;
  if (mode === "exit") process.exit(0);
  if (mode === "truncate") {
    process.stdout.write('{"type":');
    process.exitCode = 0;
    lines.close();
    process.stdout.end();
    return;
  }
  const data =
    command.type === "get_state"
      ? {
          model: { provider: "openrouter", id: "vendor/fixed-model" },
          isStreaming: false,
          isCompacting: false,
          pendingMessageCount: 0,
          messageCount: 0,
        }
      : command.type === "prompt"
        ? { disposition: "started" }
        : undefined;
  emit({ type: "response", id: command.id, command: command.type, success: true, data });
  if (command.type !== "prompt") return;
  if (mode === "malformed") {
    process.stdout.write("SECRET invalid record\n");
    return;
  }
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openrouter",
      model: "vendor/fixed-model",
      stopReason: "stop",
      content: [{ type: "text", text: command.message }],
      usage: { input: 3, output: 2 },
    },
  });
  emit({ type: "agent_end" });
  // EOF before settlement must fail even with a complete assistant answer.
  if (mode === "eof") process.stdout.end();
  else emit({ type: "agent_settled" });
});
