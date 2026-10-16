// @vitest-environment node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PiRpcInvocation, type PiRpcTransport } from "./pi-rpc.js";

const fixturePath = fileURLToPath(new URL("./fixtures/rpc-child.mjs", import.meta.url));

/** Test-only host. Production must use Rusa's sandbox and shared supervisor.
 * The existing runSubprocess helper ignores stdin and cannot drive RPC yet.
 */
async function runFixture(mode: string, prompt = "portable context", cancel = false) {
  const child = spawn(process.execPath, [fixturePath, mode], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: {},
  });
  let reaped = false;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      reaped = true;
      resolve();
    })
  );
  const transport: PiRpcTransport = {
    write: (record) =>
      new Promise<void>((resolve, reject) => {
        child.stdin.write(record, (error) => (error ? reject(error) : resolve()));
      }),
    close: () => {
      child.stdin.destroy();
      if (child.pid && !reaped) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    },
  };
  const invocation = new PiRpcInvocation(transport, "vendor/fixed-model");
  child.stdout.on("data", (chunk: Buffer) => invocation.acceptStdout(chunk));
  child.stdout.on("end", () => invocation.endStdout());
  child.once("error", () => invocation.fail("Fixture spawn failed"));
  // A killed writer may emit EPIPE independently of its write callback.
  child.stdin.on("error", () => invocation.fail("Fixture stdin failed"));
  child.stderr.resume();
  const timer = setTimeout(() => invocation.fail("Fixture deadline exceeded"), 3000);
  try {
    const result = invocation.run(prompt);
    if (cancel) await invocation.cancel();
    const outcome = await result;
    await closed;
    return { outcome, signal: child.signalCode };
  } finally {
    clearTimeout(timer);
    transport.close();
    await closed;
  }
}

describe("Pi RPC through synthetic subprocess pipes", () => {
  it("settles and reaps a peer that stays alive after agent_settled", async () => {
    const { outcome, signal } = await runFixture("success", "fresh intent 🧠\nnext line");
    expect(outcome).toMatchObject({ success: true, output: "fresh intent 🧠\nnext line" });
    expect(outcome.requests).toEqual([
      {
        requestedModel: "vendor/fixed-model",
        reportedModel: "vendor/fixed-model",
        usage: { input: 3, output: 2 },
      },
    ]);
    expect(signal).toBe("SIGKILL");
  });

  it.each([
    "exit",
    "truncate",
    "malformed",
    "eof",
  ])("rejects %s and reaps the peer", async (mode) => {
    const { outcome } = await runFixture(mode);
    expect(outcome.success).toBe(false);
    expect(outcome.reason).toBeTruthy();
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
  });

  it("bounds a peer that never answers a command", async () => {
    const { outcome, signal } = await runFixture("stall");
    expect(outcome).toMatchObject({ success: false, reason: "Fixture deadline exceeded" });
    expect(signal).toBe("SIGKILL");
  });

  it("cancels during startup and waits for process closure", async () => {
    const { outcome, signal } = await runFixture("stall", "intent", true);
    expect(outcome).toMatchObject({ success: false, reason: "Pi invocation cancelled" });
    expect(signal).toBe("SIGKILL");
  });

  it("starts each process with only its new portable intent", async () => {
    const first = await runFixture("success", "first intent");
    const second = await runFixture("success", "replacement intent");
    expect(first.outcome.output).toBe("first intent");
    expect(second.outcome.output).toBe("replacement intent");
    expect(second.outcome.requests).toHaveLength(1);
  });
});
