// @vitest-environment node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSubprocess, type SubprocessDuplex } from "../subprocess-execution.js";

const fixture = fileURLToPath(new URL("./fixtures/process-tree.mjs", import.meta.url));

// Linux may retain an orphan zombie until PID 1 reaps it. A zombie cannot execute;
// this checks termination, not reaping, and never treats kill(pid, 0) as proof of life.
async function isRunning(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

async function cleanupProcess(pid: number): Promise<void> {
  if (!(await isRunning(pid))) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

describe.skipIf(process.platform !== "linux")("supervised process-group termination", () => {
  for (const mode of ["close", "abort", "deadline"] as const) {
    it(`terminates a ready same-group descendant on ${mode}`, async () => {
      const controller = new AbortController();
      let transport: SubprocessDuplex | undefined;
      let pids: { parent: number; descendant: number } | undefined;
      let buffer = "";
      let ready: Promise<void> | undefined;
      let closure: Promise<void> | undefined;
      let readinessError: unknown;
      const result = { success: false, output: "terminated", exitCode: 1 };
      try {
        const run = runSubprocess({
          command: process.execPath,
          args: [fixture],
          cwd: process.cwd(),
          env: {},
          signal: controller.signal,
          timeoutMs: 5000,
          onDuplex: (value) => {
            transport = value;
          },
          handleStdoutData: (chunk) => {
            buffer += chunk.toString();
            if (!buffer.includes("\n") || ready) return;
            const tree: { parent: number; descendant: number } = JSON.parse(buffer.trim());
            pids = tree;
            const activeTransport = transport;
            ready = (async () => {
              expect(await isRunning(tree.parent)).toBe(true);
              expect(await isRunning(tree.descendant)).toBe(true);
              if (!activeTransport) throw new Error("Missing duplex transport");
              if (mode === "close") closure = activeTransport.close();
              if (mode === "abort") controller.abort();
            })().catch((error) => {
              readinessError = error;
              controller.abort();
            });
          },
          buildKilledResult: () => ({
            ...result,
            output: controller.signal.aborted ? "abort" : "deadline",
          }),
          buildSignalResult: (_attribution, signal) => ({ ...result, output: signal }),
          buildExitResult: () => ({ ...result, output: "unexpected natural exit" }),
          buildSpawnErrorResult: () => ({ ...result, output: "spawn failed" }),
        });
        expect(await run).toMatchObject({ ...result, output: mode === "close" ? "SIGKILL" : mode });
        expect(ready, "both processes must report readiness before termination").toBeDefined();
        await ready;
        if (readinessError) throw readinessError;
        await closure;
        if (!pids) throw new Error("Missing process readiness");
        for (const pid of [pids.parent, pids.descendant]) {
          await expect.poll(() => isRunning(pid), { timeout: 2000, interval: 20 }).toBe(false);
        }
      } finally {
        await transport?.close();
        // A failed assertion or mutation must not leave synthetic processes alive.
        if (pids) {
          for (const pid of [pids.descendant, pids.parent]) {
            await cleanupProcess(pid);
          }
        }
      }
    }, 15000);
  }
});
