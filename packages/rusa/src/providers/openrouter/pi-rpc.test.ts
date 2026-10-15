// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { PiRpcDecoder, PiRpcInvocation, type PiRpcTransport } from "./pi-rpc.js";

describe("Pi strict JSONL framing", () => {
  it("preserves split UTF-8, CRLF and literal Unicode separators", () => {
    const records: unknown[] = [];
    const decoder = new PiRpcDecoder((record) => records.push(record));
    const data = Buffer.from('{"type":"event","text":"🧠\u2028one\u2029two"}\r\n');
    for (const byte of data) decoder.push(Buffer.from([byte]));
    decoder.end();
    expect(records).toEqual([{ type: "event", text: "🧠\u2028one\u2029two" }]);
  });

  it.each([
    "not-json\n",
    "[]\n",
    "null\n",
    "{}\n",
    "\n",
  ])("rejects malformed record %j without echoing input", (line) => {
    const decoder = new PiRpcDecoder(() => {});
    expect(() => decoder.push(Buffer.from(line))).toThrow("Invalid Pi RPC record");
  });

  it("bounds each record across chunks and accepts multiple records per chunk", () => {
    const receive = vi.fn();
    const decoder = new PiRpcDecoder(receive, 20);
    decoder.push(Buffer.from('{"type":"a"}\n{"type":"b"}\n'));
    expect(receive).toHaveBeenCalledTimes(2);
    decoder.push(Buffer.from("12345678901234567890"));
    expect(() => decoder.push(Buffer.from("x"))).toThrow("record limit exceeded");
  });

  it("fails on truncated records, even if the JSON is otherwise complete", () => {
    const decoder = new PiRpcDecoder(() => {});
    decoder.push(Buffer.from('{"type":"a"}'));
    expect(() => decoder.end()).toThrow("Truncated");
  });
});

type WireRecord = Record<string, unknown>;
const model = "vendor/fixed-model";
const state = {
  model: { provider: "openrouter", id: model },
  thinkingLevel: "high",
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
  messageCount: 0,
};

function fixture(
  options: {
    state?: WireRecord;
    levels?: string[];
    disposition?: string;
    reject?: string;
    beforePromptResponse?: (invocation: PiRpcInvocation) => void;
    maxOutputBytes?: number;
    maxRequests?: number;
  } = {}
) {
  const commands: WireRecord[] = [];
  let invocation: PiRpcInvocation;
  const transport: PiRpcTransport = {
    close: vi.fn(),
    write: vi.fn(async (line) => {
      const command = JSON.parse(line) as WireRecord;
      commands.push(command);
      if (command.type === "clear_queue" || command.type === "abort") return;
      if (command.type === "prompt") options.beforePromptResponse?.(invocation);
      const data =
        command.type === "get_state"
          ? (options.state ?? state)
          : command.type === "get_available_thinking_levels"
            ? { levels: options.levels ?? ["off", "high"] }
            : command.type === "prompt"
              ? { disposition: options.disposition ?? "started" }
              : undefined;
      invocation.receive({
        type: "response",
        id: command.id,
        command: command.type,
        success: command.type !== options.reject,
        data,
        error: "SECRET provider diagnostic",
      });
    }),
  };
  invocation = new PiRpcInvocation(
    transport,
    model,
    "high",
    options.maxOutputBytes,
    options.maxRequests
  );
  return { invocation, transport, commands };
}

function assistant(invocation: PiRpcInvocation, overrides: WireRecord = {}) {
  invocation.receive({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openrouter",
      model,
      stopReason: "stop",
      content: [{ type: "text", text: "OK" }],
      ...overrides,
    },
  });
}

async function start(f: ReturnType<typeof fixture>) {
  const result = f.invocation.run("portable context and synthetic task");
  await vi.waitFor(() => expect(f.commands.some((c) => c.type === "prompt")).toBe(true));
  return { result };
}

describe("Pi RPC portable invocation spike", () => {
  it("waits beyond prompt acceptance and agent_end, then closes after settlement", async () => {
    const f = fixture();
    const { result } = await start(f);
    const finished = vi.fn();
    void result.then(finished);
    assistant(f.invocation);
    f.invocation.receive({ type: "agent_end", willRetry: false });
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    expect(f.transport.close).not.toHaveBeenCalled();
    f.invocation.receive({ type: "agent_settled" });
    expect(await result).toMatchObject({ success: true, output: "OK" });
    expect(f.transport.close).toHaveBeenCalledOnce();
    expect(f.commands.map((c) => c.type)).toEqual([
      "get_state",
      "get_available_thinking_levels",
      "set_auto_retry",
      "prompt",
    ]);
  });

  it("handles settlement before the correlated prompt response", async () => {
    const f = fixture({
      beforePromptResponse(invocation) {
        assistant(invocation);
        invocation.receive({ type: "agent_settled" });
      },
    });
    expect(await f.invocation.run("task")).toMatchObject({ success: true });
  });

  it.each([
    { ...state, model: { provider: "anthropic", id: model } },
    { ...state, model: { provider: "openrouter", id: "fuzzy-substitution" } },
    { ...state, thinkingLevel: "medium" },
    { ...state, pendingMessageCount: 1 },
    { ...state, messageCount: 1 },
    { ...state, sessionFile: "/ambient/session.jsonl" },
    { ...state, isStreaming: true },
    { ...state, isCompacting: true },
  ])("rejects mismatched or nonportable startup state %# before prompting", async (readback) => {
    const f = fixture({ state: readback });
    expect(await f.invocation.run("task")).toMatchObject({ success: false });
    expect(f.commands.some((c) => c.type === "prompt")).toBe(false);
  });

  it("rejects unsupported effort before sending a prompt", async () => {
    const f = fixture({ levels: ["off"] });
    expect(await f.invocation.run("task")).toMatchObject({ success: false });
    expect(f.commands.some((c) => c.type === "prompt")).toBe(false);
  });

  it.each(["handled", "queued"])("rejects %s prompt disposition", async (disposition) => {
    const f = fixture({ disposition });
    expect(await f.invocation.run("task")).toMatchObject({ success: false });
  });

  it.each([
    "get_state",
    "get_available_thinking_levels",
    "set_auto_retry",
    "prompt",
  ])("reports %s rejection without retaining diagnostics", async (reject) => {
    const f = fixture({ reject });
    const outcome = await f.invocation.run("task");
    expect(outcome.success).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
  });

  it.each(["error", "aborted"])("treats settled %s as failure", async (stopReason) => {
    const f = fixture();
    const { result } = await start(f);
    assistant(f.invocation, { stopReason });
    f.invocation.receive({ type: "agent_settled" });
    expect(await result).toMatchObject({ success: false });
  });

  it("fails on reported model substitution after startup", async () => {
    const f = fixture();
    const { result } = await start(f);
    assistant(f.invocation, { model: "vendor/other" });
    f.invocation.receive({ type: "agent_settled" });
    expect(await result).toMatchObject({ success: false, reason: "Pi reported a different model" });
  });

  it("retains each completed request once, with missing usage and model unknown", async () => {
    const f = fixture();
    const { result } = await start(f);
    f.invocation.receive({ type: "message_update", usage: { totalTokens: 10 } });
    assistant(f.invocation, { usage: { totalTokens: 25, cost: { total: 0.01 } } });
    f.invocation.receive({ type: "turn_end", message: {} });
    assistant(f.invocation, { usage: undefined, model: undefined });
    f.invocation.receive({ type: "agent_settled" });
    const outcome = await result;
    expect(outcome.requests).toEqual([
      {
        requestedModel: model,
        reportedModel: model,
        usage: { totalTokens: 25, cost: { total: 0.01 } },
      },
      { requestedModel: model, reportedModel: undefined, usage: undefined },
    ]);
  });

  it("retains partial usage when the host reports stream interruption", async () => {
    const f = fixture();
    const { result } = await start(f);
    assistant(f.invocation, { usage: { totalTokens: 12 } });
    f.invocation.fail("stream interruption");
    expect(await result).toMatchObject({
      success: false,
      requests: [{ usage: { totalTokens: 12 } }],
    });
  });

  it.each([
    '{"type":"message_end","message":null}\n',
    '{"type":"message_end","message":{"role":"assistant","usage":5}}\n',
    "SECRET-invalid-json\n",
  ])("settles malformed stdout without exposing the record %#", async (line) => {
    const f = fixture();
    const { result } = await start(f);
    f.invocation.acceptStdout(Buffer.from(line));
    const outcome = await result;
    expect(outcome.success).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
  });

  it("fails when stdout ends before settlement", async () => {
    const f = fixture();
    const { result } = await start(f);
    assistant(f.invocation);
    f.invocation.endStdout();
    expect(await result).toMatchObject({ success: false });
  });

  it("rejects truncated stdout after acceptance", async () => {
    const f = fixture();
    const { result } = await start(f);
    f.invocation.acceptStdout(Buffer.from('{"type":"agent_settled"}'));
    f.invocation.endStdout();
    expect(await result).toMatchObject({ success: false, reason: "Truncated Pi RPC output" });
  });

  it("bounds output independently of wire record size", async () => {
    const f = fixture({ maxOutputBytes: 1 });
    const { result } = await start(f);
    assistant(f.invocation);
    expect(await result).toMatchObject({ success: false, reason: "Pi RPC output limit exceeded" });
  });

  it("bounds retained request count", async () => {
    const f = fixture({ maxRequests: 1 });
    const { result } = await start(f);
    assistant(f.invocation);
    assistant(f.invocation);
    expect(await result).toMatchObject({ success: false, requests: [expect.any(Object)] });
  });

  it("clears queued work, aborts and closes exactly once on cancellation", async () => {
    const f = fixture();
    const { result } = await start(f);
    f.invocation.cancel();
    f.invocation.cancel();
    f.invocation.receive({ type: "agent_settled" });
    expect(await result).toMatchObject({ success: false, reason: "Pi invocation cancelled" });
    expect(f.commands.slice(-2).map((c) => c.type)).toEqual(["clear_queue", "abort"]);
    expect(f.transport.close).toHaveBeenCalledOnce();
    await expect(f.invocation.run("again")).rejects.toThrow("already used");
  });

  it("fails on an uncorrelated response rather than leaving an in-flight command pending", async () => {
    const f = fixture();
    const { result } = await start(f);
    f.invocation.receive({ type: "response", command: "prompt", id: "unknown", success: true });
    expect(await result).toMatchObject({ success: false, reason: "Unexpected Pi RPC response" });
  });

  it("settles a failed stdin write without leaking its exception", async () => {
    const transport: PiRpcTransport = {
      write: async () => {
        throw new Error("SECRET stdin failure");
      },
      close: vi.fn(),
    };
    const invocation = new PiRpcInvocation(transport, model, "high");
    const result = await invocation.run("task");
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("cancels while startup readback is pending", async () => {
    const transport: PiRpcTransport = { write: vi.fn(async () => {}), close: vi.fn() };
    const invocation = new PiRpcInvocation(transport, model, "high");
    const result = invocation.run("task");
    invocation.cancel();
    expect(await result).toMatchObject({ success: false, reason: "Pi invocation cancelled" });
    // A deferred startup write must never reach a transport already closed by cancel.
    expect(transport.write).toHaveBeenCalledTimes(2);
  });

  it("still closes when cooperative abort writes throw synchronously", async () => {
    const transport: PiRpcTransport = {
      write: () => {
        throw new Error("closed");
      },
      close: vi.fn(),
    };
    const invocation = new PiRpcInvocation(transport, model, "high");
    const result = invocation.run("task");
    invocation.cancel();
    expect(await result).toMatchObject({ success: false, reason: "Pi invocation cancelled" });
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("does not treat empty settlement as completed work", async () => {
    const f = fixture();
    const { result } = await start(f);
    f.invocation.receive({ type: "agent_settled" });
    expect(await result).toMatchObject({
      success: false,
      reason: "Pi returned no assistant message",
    });
  });
});
