// @vitest-environment node

import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { isOpenRouterAdmitted, OPENROUTER_USE_CAPABILITY } from "../../actor/provider-use.js";
import { runMigrations } from "../../db/migrations/runner.js";
import { DbCapabilityGrantStore } from "../../db/repositories/capability-grant-repository.js";
import * as subprocess from "../subprocess-execution.js";
import { OpenRouterProvider } from "./provider.js";

vi.mock("../../config/loader.js", () => ({
  loadConfig: () => ({ github: { account: "test" }, providers: {}, gitBridge: false }),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock("../subprocess-execution.js", { spy: true });

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openrouter-provider-test-"));
  roots.push(root);
  const apiKeyPath = join(root, "auth.json");
  await writeFile(
    apiKeyPath,
    JSON.stringify({
      openrouter: {
        type: "oauth",
        access: "synthetic-not-a-real-key",
        refresh: "",
        expires: Number.MAX_SAFE_INTEGER,
      },
      other: { type: "api_key", key: "other-secret" },
    }),
    { mode: 0o600 }
  );
  const executableRoot = await mkdtemp(join(process.cwd(), ".openrouter-host-probe-"));
  roots.push(executableRoot);
  const piCommand = join(executableRoot, "pi");
  await writeFile(
    piCommand,
    `#!/bin/sh\nexec '${process.execPath}' '${fileURLToPath(new URL("./fixtures/rpc-child.mjs", import.meta.url))}' "$@"\n`,
    { mode: 0o700 }
  );
  const config = {
    openrouterPoc: {
      piCommand,
      authDir: root,
      artifactDir: join(root, "artifacts"),
    },
  };
  return {
    root,
    apiKeyPath,
    config,
    provider: new OpenRouterProvider("test", config, "vendor/fixed-model"),
  };
}
it("requires opt-in and refuses native sessions before inference", async () => {
  const { root, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "");
  await expect(
    provider.run({ openrouterAdmitted: true, cwd: root, prompt: "ping" })
  ).rejects.toThrow(/requires/);
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  await expect(
    provider.run({
      openrouterAdmitted: true,
      cwd: root,
      prompt: "ping",
      session: { id: "native-session" },
    })
  ).rejects.toThrow(/fresh runs/);
});
it("requires the independently managed Pi login", async () => {
  const { root, apiKeyPath, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  await rm(apiKeyPath);
  await expect(
    provider.run({ openrouterAdmitted: true, cwd: root, prompt: "ping" })
  ).rejects.toThrow(/launch pi/);
});
it("uses a static Pi login without changing the source profile", async () => {
  const { root, apiKeyPath, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const source = JSON.stringify({
    openrouter: { type: "api_key", key: "synthetic-not-a-real-key" },
  });
  await writeFile(apiKeyPath, source);
  expect(
    (await provider.run({ openrouterAdmitted: true, cwd: root, prompt: "ping" })).success
  ).toBe(true);
  expect(await readFile(apiKeyPath, "utf8")).toBe(source);
  await writeFile(
    apiKeyPath,
    JSON.stringify({ openrouter: { type: "api_key", key: "!echo secret" } })
  );
  await expect(
    provider.run({ openrouterAdmitted: true, cwd: root, prompt: "ping" })
  ).rejects.toThrow(/launch pi/);
});
it("settles through real pipes, reaps the peer and retains usage without a subscription token record", async () => {
  const { root, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const result = await provider.run({
    openrouterAdmitted: true,
    cwd: root,
    prompt: "ping-unique",
    mcpServers: [{ name: "inbox", url: "http://synthetic.invalid" }],
  });
  expect(result).toEqual({
    success: true,
    output: "ping-unique",
    exitCode: 0,
  });
  const artifacts = await readdir(join(root, "artifacts"));
  expect(artifacts).toHaveLength(1);
  const receipt = await readFile(join(root, "artifacts", artifacts[0] as string), "utf8");
  expect(JSON.parse(receipt).requests[0].usage).toEqual({ input: 3, output: 2 });
  expect(receipt).not.toContain("synthetic-not-a-real-key");
}, 10000);

it("leaves cwd untouched when artifact storage is not requested", async () => {
  const { root, config } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const { artifactDir: _artifactDir, ...paths } = config.openrouterPoc;
  const provider = new OpenRouterProvider("test", { openrouterPoc: paths }, "vendor/fixed-model");
  const cwd = join(root, "nonexistent-workspace");
  expect((await provider.run({ openrouterAdmitted: true, cwd, prompt: "ping" })).success).toBe(
    true
  );
  await expect(readdir(cwd)).rejects.toThrow(/ENOENT/);
});

it("retains distinct artifacts for concurrent invocations", async () => {
  const { root, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const results = await Promise.all([
    provider.run({ openrouterAdmitted: true, cwd: root, prompt: "one" }),
    provider.run({ openrouterAdmitted: true, cwd: root, prompt: "two" }),
  ]);
  expect(results.every((result) => result.success)).toBe(true);
  expect(await readdir(join(root, "artifacts"))).toHaveLength(2);
});

let bwrapCapable = false;
try {
  execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
  bwrapCapable = true;
} catch {}
it.skipIf(!bwrapCapable)(
  "launches the synthetic RPC peer inside the real worker sandbox",
  async () => {
    const { root, provider } = await fixture();
    vi.stubEnv("RUSA_OPENROUTER_POC", "1");
    const actor = join(root, "workers", "actor");
    const sibling = join(root, "workers", "sibling");
    const secrets = join(root, "secrets");
    await Promise.all([actor, sibling, secrets].map((path) => mkdir(path, { recursive: true })));
    const hostRoot = await mkdtemp(join(process.cwd(), ".openrouter-host-probe-"));
    roots.push(hostRoot);
    const probe = {
      ownFile: join(actor, "own"),
      siblingFile: join(sibling, "private"),
      secretFile: join(secrets, "ungranted"),
      hostFile: join(hostRoot, "host-file"),
    };
    await Promise.all(
      Object.entries(probe).map(([name, path]) =>
        writeFile(path, name === "ownFile" ? "own" : "private")
      )
    );
    const prompt = `sandbox-probe:${JSON.stringify(probe)}`;
    const result = await provider.run({
      openrouterAdmitted: true,
      cwd: actor,
      prompt,
      sandbox: { worktreePath: actor },
      mcpServers: [{ name: "inbox", url: "http://synthetic.invalid" }],
    });
    expect(result).toEqual({ success: true, output: prompt, exitCode: 0 });
    expect(await readFile(probe.ownFile, "utf8")).toBe("updated");
    expect(await readFile(probe.hostFile, "utf8")).toBe("private");
  },
  15000
);

it("checks real SQLite grants per launch and denies before login read or subprocess spawn", async () => {
  const { root, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const db = new Database(":memory:");
  runMigrations(db);
  const insert = db.prepare(
    "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'test', ?, '2026-10-19T00:00:00Z')"
  );
  insert.run("root", null);
  insert.run("worker", "root");
  insert.run("sibling", "root");
  const grants = new DbCapabilityGrantStore(db);
  const read = vi.mocked(fsPromises.readFile);
  read.mockClear();
  const spawn = vi.mocked(subprocess.runSubprocess);
  spawn.mockClear();
  const worker = join(root, "workers", "worker");
  await mkdir(worker, { recursive: true });
  const launch = () =>
    provider.run({
      cwd: worker,
      ...(bwrapCapable ? { sandbox: { worktreePath: worker } } : {}),
      prompt: "grant-proof",
      openrouterAdmitted: isOpenRouterAdmitted(grants, "worker", false),
    });
  const denied = async () => {
    read.mockClear();
    spawn.mockClear();
    await expect(launch()).rejects.toThrow(/admission required/);
    expect(read).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  };
  try {
    // A raw adapter call has no authority, even if its caller has selected this model.
    await expect(provider.run({ cwd: root, prompt: "missing-admission" })).rejects.toThrow(
      /admission required/
    );
    expect(read).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    await denied();
    grants.grant({
      actorId: "sibling",
      capability: OPENROUTER_USE_CAPABILITY,
      grantedBy: "root",
      grantedAt: "2026-10-19T00:00:00Z",
    });
    await denied();
    grants.grant({
      actorId: "worker",
      capability: OPENROUTER_USE_CAPABILITY,
      grantedBy: "root",
      grantedAt: "2026-10-19T00:00:00Z",
    });
    expect((await launch()).success).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    grants.revoke("worker", OPENROUTER_USE_CAPABILITY, "2026-10-19T00:01:00Z");
    await denied();
    expect(isOpenRouterAdmitted(grants, "root", true)).toBe(true);
    expect(isOpenRouterAdmitted(grants, "root", false)).toBe(false);
  } finally {
    db.close();
  }
}, 10000);
