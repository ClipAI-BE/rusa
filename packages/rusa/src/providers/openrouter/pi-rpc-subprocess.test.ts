// @vitest-environment node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PiRpcInvocation, type PiRpcTransport } from "./pi-rpc.js";

const fixturePath = fileURLToPath(new URL("./fixtures/rpc-child.mjs", import.meta.url));

/** Test-only host. Production must use Rusa's sandbox and shared supervisor.
 * The existing runSubprocess helper ignores stdin and cannot drive RPC yet.
 */
async function runFixture(mode: "success" | "eof", prompt = "portable context") {
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
  }, 10000);

  it("rejects EOF before settlement and reaps the peer", async () => {
    const { outcome, signal } = await runFixture("eof");
    expect(outcome).toMatchObject({
      success: false,
      reason: "Pi subprocess ended before settlement",
    });
    expect(signal).toBe("SIGKILL");
  }, 10000);
});
