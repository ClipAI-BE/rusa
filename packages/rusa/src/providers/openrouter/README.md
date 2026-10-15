# OpenRouter / Pi protocol spike (#808)

This is the first part of the no-schema fixture spike proposed in
[#808](https://github.com/MEK-Org/rusa/issues/808). It implements the Pi RPC wire
boundary for one fresh portable invocation. It is not registered as a production
provider. Importing it cannot launch a harness or spend inference credit.

The contract targets `@earendil-works/pi-coding-agent@0.99.2`, source
`005af57d88ee23b33778f343a9595b32e67ff788`. This is a protocol compatibility
target, not an installed or verified executable. The authoritative references are
the pinned [RPC protocol](https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/coding-agent/docs/rpc.md),
[commands](https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/coding-agent/docs/rpc-commands.md),
and [events](https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/coding-agent/docs/json.md).

## Implemented boundary

- LF-only framing handles CRLF, split UTF-8 and literal Unicode separators.
  Records, accumulated assistant output and retained request count have limits.
- Before prompting, read back the exact OpenRouter model and thinking level,
  reject a nonempty or persistent session, check supported thinking levels, and
  disable automatic inference retries.
- Correlate responses by command ID. Prompt acceptance and `agent_end` do not
  settle the invocation. Wait for `agent_settled`, including when it arrives
  before the prompt response. Rejected, queued or extension-handled prompts fail.
- Provider errors, aborts, reported model changes, malformed records and a stream
  ending before settlement fail. Command diagnostics are omitted from failures.
- Retain one usage observation per completed assistant message, including partial
  work before interruption. Streaming and turn-end echoes do not duplicate it.
  Raw usage is a harness report. It is not a measurement of OpenRouter billed
  cost. Missing reported model or usage stays unknown. Nothing writes accounting
  rows, estimates supplier identity or persists a new provider under another name.
- Cancellation sends `clear_queue` and `abort` and closes the transport. The host
  remains responsible for deadlines and killing/reaping the entire process group.

`PiRpcTransport` is an injected boundary. Its writer must honor backpressure;
its closer must close stdin and arrange process cleanup. The fixtures implement
this interface in memory. They are synthetic protocol records, not captured
evidence that the released Pi binary works with Rusa.

## Before production registration

The rest of #808 remains open. A production adapter needs the following evidence:

1. Verify a pinned executable and reuse the supervised subprocess/sandbox path.
   Generate isolated agent/auth/session configuration. Deny ambient project
   settings, instructions, extensions, skills, prompts and extra MCP endpoints.
   Prove this with a poisoned environment and a real offline harness invocation.
2. Supply actor-bound MCP endpoints and fail readiness if any required endpoint
   cannot connect. Prove granted calls work and ungranted calls are refused.
3. Resolve inference credentials through the existing actor secret grant. Model
   access to its own capped inference key is part of the threat model. Verify
   cross-actor isolation and credential redaction in actual process output.
4. Add opt-in configuration, exact model/capability validation and budget admission.
   Missing, expired or exhausted budget must block even responsive starts, while
   allowing another available pool entry. A prepaid balance does not enter quota
   reset-window pacing. Exercise real provider error translation for 401, 402,
   429, 5xx, stream failure, cancellation and timeout.
5. Prove process cleanup, yield, restart and model-switch portable continuity with
   subprocess fixtures. The protocol tests here prove cancellation commands, not
   process-group termination or filesystem isolation.
6. After operator provisioning and routing/data-policy review, run the separate
   capped synthetic smoke test. Record the executable version, adapter head,
   actual emitted records and spend. Durable accounting and its schema review
   remain a separate slice.

## Local fixture verification

From `packages/rusa`, run:

```sh
pnpm exec vitest run src/providers/openrouter/pi-rpc.test.ts
```

The settlement test also rejects a mutation that treats `agent_end` as terminal:
it observes transport closure before `agent_settled` and fails. Restore the source
after the mutation before running the normal suite.
