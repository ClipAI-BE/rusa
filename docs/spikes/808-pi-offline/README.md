# Pi 0.99.2 offline compatibility receipt

This opt-in probe sends only five state/configuration RPC commands to a real Pi
child through Rusa's shared supervisor. It sends no prompt and supplies no
inference credential. It is separate from CI and production registration.

## Pins and setup

Observed on Linux x64, 2026-10-17. Host Node 20.19.2 cannot start this Pi release
(missing `node:module.enableCompileCache`). Use the temporary Node below; leave
the service runtime unchanged.

* Pi: `@earendil-works/pi-coding-agent@0.99.2`, source
  `005af57d88ee23b33778f343a9595b32e67ff788`.
* Pi archive SHA-512 (base64):
  `6R1BZ2N77CrVcGf3eC2KovTz1Q4RYiAeydvVWQT546N2fi1nBc81aURlbOZCgruWoW9VY/UrLzDynF4YTolpoA==`.
* Node `v22.19.0`, linux-x64 archive SHA-256:
  `c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2`.
* Published npm-shrinkwrap.json SHA-256:
  `036c4af893d78da7df2d8b1464db904e8e2c4ad73a4d6c572f1161699fdaedf5`.

From the repository root, with Python 3.12+, curl, tar, sha256sum, pnpm and the
repository dependencies installed:

```sh
probe_dir=$(mktemp -d)
export probe_dir
curl --fail --location https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz -o "$probe_dir/node.tar.xz"
echo "c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2  $probe_dir/node.tar.xz" | sha256sum -c -
tar -xJf "$probe_dir/node.tar.xz" -C "$probe_dir"
curl --fail --location https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.99.2.tgz -o "$probe_dir/pi.tgz"
python3 - <<'PY'
import base64, hashlib, os, pathlib, tarfile
p = pathlib.Path(os.environ['probe_dir'])
assert base64.b64encode(hashlib.sha512((p/'pi.tgz').read_bytes()).digest()).decode() == '6R1BZ2N77CrVcGf3eC2KovTz1Q4RYiAeydvVWQT546N2fi1nBc81aURlbOZCgruWoW9VY/UrLzDynF4YTolpoA=='
with tarfile.open(p/'pi.tgz') as archive:
    archive.extractall(p, filter='data')
PY
echo "036c4af893d78da7df2d8b1464db904e8e2c4ad73a4d6c572f1161699fdaedf5  $probe_dir/package/npm-shrinkwrap.json" | sha256sum -c -
cp "$probe_dir/package/package.json" "$probe_dir/package/package.json.original"
patch -d "$probe_dir/package" package.json < docs/spikes/808-pi-offline/manifest.patch
PATH="$probe_dir/node-v22.19.0-linux-x64/bin:$PATH" npm --prefix "$probe_dir/package" ci --omit=dev --ignore-scripts --no-audit --no-fund --legacy-peer-deps
echo "036c4af893d78da7df2d8b1464db904e8e2c4ad73a4d6c572f1161699fdaedf5  $probe_dir/package/npm-shrinkwrap.json" | sha256sum -c -
env -i "$probe_dir/node-v22.19.0-linux-x64/bin/node" "$probe_dir/package/dist/bundle/cli.js" --version
pnpm --filter rusa exec tsup src/providers/subprocess-execution.ts --format esm --no-config --out-dir "$probe_dir/supervisor"
node docs/spikes/808-pi-offline/probe.mjs "$probe_dir/supervisor/subprocess-execution.js" "$probe_dir/node-v22.19.0-linux-x64/bin/node" "$probe_dir/package/dist/bundle/cli.js" > "$probe_dir/receipt.jsonl"
cat "$probe_dir/receipt.jsonl"
```

Stop on any failed command. Retain the receipt, then remove the temporary prefix
when finished. Downloads and dependency installation require network access;
the RPC launch uses an explicitly empty inherited environment plus only the five
entries logged in the receipt. `PI_OFFLINE` is not a network sandbox.

The temporary manifest patch removes devDependencies and reformats JSON without other value changes. The first npm 10.9.3
`ci --omit=dev --ignore-scripts` attempt crashed in peer resolution; adding
`--legacy-peer-deps` exposed development dependencies missing from the published
production shrinkwrap. With the patch and commands above, installation completed
with 121 packages. The shrinkwrap remained unchanged. The original manifest and
exact diff are retained so this workaround is reviewable.

## Observations and limits

`startup-receipt.jsonl` is the original five-command receipt using the supervisor
from reviewed head `69d388d90f4e7e3533b207812775d6919783091a`. Its executable probe
was the local predecessor of `probe.mjs`. `isolation-receipt.jsonl` records the
three scenarios in the checked-in probe, using a freshly built supervisor from staging `8009e5bd`.
The supervisor landed without a diff change in staging `8009e5bd`.

All three scenarios correlate five IDs/commands, report the exact requested
OpenRouter model, zero messages/pending messages, no session file, and no streaming.
The launch has no tools, extensions, skills, templates, context discovery or
themes. The child remains alive until supervisor close. The observed child
signal is SIGKILL. `result.exitCode: 0` is the probe's normalized signal result,
not a natural child exit status. The probe awaits direct-child closure and
asserts ENOENT after deleting each temporary launch directory.

| Scenario | Conflicting settings | Initial compaction | After RPC disable |
| --- | --- | --- | --- |
| baseline | none outside explicit agent directory | false | false |
| untrusted-poison | HOME/.pi/agent and cwd/.pi, with --no-approve | false | false |
| trusted-control | same files, with --approve | true | true |

Poison files enable compaction and request a conflicting model/provider. All
scenarios explicitly disable warming/retry and pin the requested CLI model.
The trusted control demonstrates that the project poison is effective. Pi reports
success for `set_auto_compaction(false)` while effective state remains true under
the trusted project override. The first probe run expected false after that
command and failed; the retained receipt asserts the observed override behavior.
Production admission must verify effective state rather than trust success alone.

These assertions cover only the reported model and compaction setting. They do
not establish complete configuration/credential isolation, denied extra tools,
network isolation, native MCP readiness/authorization, descendant containment,
inference behavior, budgets or accounting. Startup reads project settings before
runtime trust handling; this probe does not establish which startup side effects
are possible. #808 and its paid-test/registration gates remain open.
