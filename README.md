[![CI](https://github.com/isanchez31/opencode-sandbox-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/isanchez31/opencode-sandbox-plugin/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode-sandbox)](https://www.npmjs.com/package/opencode-sandbox)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# opencode-sandbox

An [OpenCode](https://opencode.ai) plugin that sandboxes agent-executed commands using [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).

Every command the agent runs through OpenCode is wrapped with OS-level filesystem and network restrictions — no containers, no VMs, just native OS sandboxing primitives.

| Platform | Mechanism |
|----------|-----------|
| **macOS** | `sandbox-exec` (Seatbelt profiles) |
| **Linux** | `bubblewrap` (namespace isolation) |
| **Windows** | Not yet supported (commands are blocked) |

## Install

Requires OpenCode 2 or later.

> **Not published for OpenCode 2 yet.** npm's `opencode-sandbox@0.6.0` is the
> OpenCode 1 package (it peers on `@opencode-ai/plugin`), so
> `"plugins": ["opencode-sandbox"]` installs code OpenCode 2 does not run.
> Until a V2 release is published, install from this repository.

Build a local checkout once, then point `plugins` at its directory:

```bash
git clone --branch feat/v2-compat https://github.com/KRiedmiller/opencode-sandbox-plugin
cd opencode-sandbox-plugin
bun install
bun run build   # writes dist/index.js and dist/tui.js
```

The build is required. The package declares `name` and `exports`, so OpenCode
loads it through `exports` (`./dist/index.js` and `./dist/tui.js`); a checkout
without a built `dist/` fails to load. Installing straight from git does not
build it either, because this repository has no `prepare` script.

```json
{
  "plugins": ["/absolute/path/to/opencode-sandbox-plugin"]
}
```

Local entries are not update-checked by OpenCode. After `git pull`, rerun
`bun install && bun run build`; OpenCode watches `dist/` and reloads the plugin.
The `bun install` step is required: this fork carries a Bun patch for
`@anthropic-ai/sandbox-runtime@0.0.76` (Linux device passthrough), and Bun
reapplies it on every install. See [Maintenance](#maintenance) for the patch
lifecycle and upgrade steps.

Verify the plugin loaded by looking for a `loading plugin` line with this path
in the OpenCode server log, or for the status-bar badge in the TUI
(`⊙ sandbox: on`). Local directory entries do not appear in `opencode plugin
list`.

### Linux prerequisites

**1. Install the dependencies:**

`bubblewrap` provides the sandbox, `socat` relays traffic to the network
allowlist proxy, and `ripgrep` is used for deny-path detection.

```bash
# Debian/Ubuntu
sudo apt install bubblewrap socat ripgrep

# Fedora
sudo dnf install bubblewrap socat ripgrep

# Arch
sudo pacman -S bubblewrap socat ripgrep
```

Check that bubblewrap can start:

```bash
bwrap --ro-bind / / --dev /dev --proc /proc -- echo "sandbox works"
```

**2. Ubuntu 24.04+ (user namespace restriction):**

Ubuntu sets `kernel.apparmor_restrict_unprivileged_userns=1`, which allows a
process to create a capability-bearing user namespace only when its AppArmor
profile grants `userns`. Two different steps break, with different errors:

| Error | What is blocked |
|-------|-----------------|
| `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` or `setting up uid map: Permission denied` | bubblewrap cannot create its namespace |
| `apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN): Permission denied` | bubblewrap works, but the seccomp helper cannot create the nested namespace it needs |

Ubuntu's packaged `bwrap-userns-restrict` profile only covers the first: it
grants the namespace permission to `bwrap` itself but deliberately denies
capabilities to bwrap's children, so `apply-seccomp` still fails. Profile
transitions cannot fix that either, because bwrap runs with `no_new_privs`
(AppArmor refuses them with `no new privs`).

Install [`contrib/apparmor/opencode-sandbox-bwrap`](contrib/apparmor/opencode-sandbox-bwrap)
instead. It grants the namespace permission to `/usr/bin/bwrap` and the
processes it starts, and changes nothing for the rest of the system:

```bash
sudo install -m 0644 contrib/apparmor/opencode-sandbox-bwrap \
  /etc/apparmor.d/opencode-sandbox-bwrap
sudo apparmor_parser -r /etc/apparmor.d/opencode-sandbox-bwrap
```

The profile lives in `/etc/apparmor.d/`, so it is loaded again on every boot.
To remove it:

```bash
sudo apparmor_parser -R /etc/apparmor.d/opencode-sandbox-bwrap
sudo rm /etc/apparmor.d/opencode-sandbox-bwrap
```

The tradeoff: this profile does not re-restrict capabilities *inside* bwrap.
The alternative documented by `sandbox-runtime`, `sudo sysctl -w
kernel.apparmor_restrict_unprivileged_userns=0`, has the same effect but
reopens capability-bearing user namespaces system-wide (and does not survive a
reboot unless it is written to `/etc/sysctl.d/`). Filesystem and network
isolation are unaffected either way — they are enforced by bwrap's namespaces
and mounts, not by AppArmor.

If the setup is still broken, the plugin does not run commands unsandboxed: it
**blocks** them and reports the reason. Diagnostics go to the OpenCode server
log, prefixed with `[opencode-sandbox]`.

## What it does

When the agent runs a command, the sandbox enforces three layers of protection:

### Filesystem write protection

Commands can only write to the project directory and `/tmp`. Writing anywhere else returns "Read-only file system":

```
$ touch ~/some-file
touch: cannot touch '/home/user/some-file': Read-only file system

$ echo "data" > /etc/config
/usr/bin/bash: line 1: /etc/config: Read-only file system
```

### Sensitive file read protection

Access to credential directories is blocked:

```
$ cat ~/.ssh/id_rsa
cat: /home/user/.ssh/id_rsa: Permission denied
```

### Network allowlist

Only approved domains are reachable. All other traffic is blocked via a local proxy:

```
$ curl https://evil.com
Connection blocked by network allowlist

$ curl https://registry.npmjs.org
(works — npmjs.org is in the default allowlist)
```

### Default restrictions

**Filesystem (deny-read)**:

- `~/.ssh`, `~/.gnupg`
- `~/.aws/credentials`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`
- `~/.kube`, `~/.docker/config.json`
- `~/.npmrc`, `~/.netrc`, `~/.env`

**Filesystem (allow-read)**:

- Empty by default

**Filesystem (allow-write)**:

- Project directory
- Git worktree (validated — unsafe paths like `/` are rejected)
- `/tmp`

**Network (allow-only)**:

- `registry.npmjs.org`, `*.npmjs.org`
- `registry.yarnpkg.com`
- `pypi.org`, `*.pypi.org`, `crates.io`, `*.crates.io`
- `github.com`, `*.github.com`
- `gitlab.com`, `*.gitlab.com`, `bitbucket.org`, `*.bitbucket.org`
- `api.openai.com`, `api.anthropic.com`
- `*.googleapis.com`

Everything else is **blocked by default**.

### Enforcement self-check

Initialization succeeding says nothing about the OS sandbox actually enforcing at spawn time. Before the first agent command runs (once per session), the plugin executes a probe under the sandbox: a write outside the allowed write paths and a read of a denied path must both fail. If either succeeds — or the probe cannot run — commands are **blocked** (fail closed) with the reason in the error message. On Linux this catches a broken bubblewrap setup up front instead of as a mysterious per-command failure; see [Linux prerequisites](#linux-prerequisites) for the fix.

## Configuration

Config files are stored outside the project directory (in `~/.config/opencode/` or `~/.config/opencode-sandbox/`) so that sandboxed commands cannot modify them. This prevents indirect prompt injection from weakening the sandbox by overwriting the config.

### Invalid config fails closed

A config source that exists but cannot be used — invalid JSON, or values of the wrong shape (`denyRead` must be an array of strings, `disabled` a boolean, …) — makes the plugin **block commands** with the reason in the error message, instead of silently falling back to weaker defaults. Unknown keys are ignored with a warning (they may be written for a newer plugin version). Fix the file or toggle the sandbox off to run unsandboxed while fixing it.

### Config file locations

The plugin searches for configuration in this order (first match wins):

1. **Environment variable** `OPENCODE_SANDBOX_CONFIG` (JSON string)
2. **Environment variable** `OPENCODE_SANDBOX_CONFIG_PATH` (path to a JSON config file)
3. **Per-project config** `~/.config/opencode/projects/<project-name>.sandbox.json`
4. **Legacy per-project config** `~/.config/opencode-sandbox/projects/<project-name>.json`
5. **Global config** `~/.config/opencode/sandbox.json`
6. **Legacy global config** `~/.config/opencode-sandbox/config.json`
7. **Built-in defaults**

The `<project-name>` is the basename of the project directory (e.g., `my-app` for `/home/user/projects/my-app`).

If `XDG_CONFIG_HOME` is set, it is used instead of `~/.config`. Files are not
merged: the first matching source is the whole user config, and built-in
defaults fill any keys it omits.

### Config reference

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `disabled` | boolean | `false` | Disable the plugin for this project. |
| `environment` | Record<string, string> | `{}` | Extra environment variables for every sandboxed command. Values are literal (no `~` or `$VAR` expansion); use absolute paths. |
| `filesystem.denyRead` | string[] | credential paths (`~/.ssh`, `~/.gnupg`, …) | Paths hidden from the sandbox (tmpfs or `/dev/null` mask). |
| `filesystem.allowRead` | string[] | `[]` | Re-allow paths inside a denied path; takes precedence over `denyRead`. |
| `filesystem.allowWrite` | string[] | project directory, worktree, temp dir | Writable paths; relative entries resolve against the project. |
| `filesystem.denyWrite` | string[] | `[]` | Re-deny writes inside allowed paths; takes precedence over `allowWrite`. |
| `filesystem.allowDevices` | string[] | `[]` | Linux only. Absolute canonical paths under `/dev/` bound into the sandbox. Requires the Bun patch in this fork; see [Linux device passthrough](#linux-device-passthrough). |
| `network.allowedDomains` | string[] | npm, PyPI, GitHub, OpenAI, Anthropic, Google APIs | Domains allowed through the proxy. Replaces the default list. |
| `network.deniedDomains` | string[] | `[]` | Explicitly denied domains. |
| `network.allowUnixSockets` | string[] | unset | macOS: allow specific socket paths. Ignored on Linux (seccomp cannot filter by path). |
| `network.allowAllUnixSockets` | boolean | `false` | Linux: skips `apply-seccomp`, which CUDA needs. Disables Unix-socket and `io_uring` blocking; high-risk socket paths are masked automatically. See [Linux device passthrough](#linux-device-passthrough). |
| `network.allowLocalBinding` | boolean | `false` | Allow binding local ports. |

Array-valued keys replace their defaults rather than merge, with one exception:
the automatic socket masks added when `allowAllUnixSockets` is enabled are
appended to whatever `denyRead` list is active.

### Example: Global config

```json
// ~/.config/opencode/sandbox.json
{
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws/credentials"],
    "allowRead": ["~/.ssh/id_ed25519.pub"],
    "allowWrite": [".", "/tmp", "/var/data"],
    "denyWrite": [".env.production"]
  },
  "network": {
    "allowedDomains": [
      "registry.npmjs.org",
      "github.com",
      "*.github.com",
      "api.openai.com",
      "api.anthropic.com",
      "my-internal-api.company.com"
    ],
    "deniedDomains": ["malicious.example.com"]
  }
}
```

### Command environment variables

Use `environment` to give every sandboxed command a fixed set of variables.
This is useful for tools that insist on writing caches under `$HOME`, which
stays read-only inside the sandbox:

```json
{
  "environment": {
    "NUMBA_CACHE_DIR": "/tmp/opencode/cache/numba",
    "XDG_CACHE_HOME": "/tmp/opencode/cache/xdg",
    "MPLCONFIGDIR": "/tmp/opencode/cache/matplotlib"
  }
}
```

Values are passed through literally; use absolute paths. They are visible to
the agent's shell and its child processes. Treat this as trusted config:
overriding `PATH` or loader variables affects every command. Do not put
secrets here — use the runtime's credential masking instead. For sandboxed
commands, the plugin's own `OPENCODE_SANDBOX_REAL_SHELL` /
`OPENCODE_SANDBOX_WRAPPED_COMMAND` variables take precedence over entries in
this map. Like every config key, this requires an OpenCode restart because
`SandboxManager.initialize()` is process-global.

### Linux device passthrough

`filesystem.allowDevices` passes individual host devices into the Linux sandbox.
It is Linux-only and opt-in; the default is no extra devices beyond the minimal
`/dev` that bubblewrap creates.

> **Scope:** the example below uses the *global* config, so it enables GPU
> access for every project. Prefer a per-project file for GPU work: config
> lookup is first-match-wins and does not merge, so
> `~/.config/opencode/projects/<project>.sandbox.json` replaces the global file
> for that project (built-in defaults still fill omitted keys).

For example, to give the sandboxed agent access to an NVIDIA GPU:

```json
// ~/.config/opencode/sandbox.json
{
  "filesystem": {
    "allowDevices": ["/dev/nvidiactl", "/dev/nvidia0", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools", "/dev/nvidia-modeset"]
  },
  "network": {
    "allowAllUnixSockets": true
  }
}
```

The same settings in a per-project file keep GPU access out of every other
project:

```json
// ~/.config/opencode/projects/my-gpu-app.sandbox.json
{
  "filesystem": {
    "allowDevices": ["/dev/nvidiactl", "/dev/nvidia0", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools", "/dev/nvidia-modeset"]
  },
  "network": {
    "allowAllUnixSockets": true
  }
}
```

`<project-name>` is the basename of the project directory, so
`/home/user/projects/my-gpu-app` uses `my-gpu-app.sandbox.json`.

Each path is mounted with bubblewrap's `--dev-bind-try` after the minimal `/dev`
is set up, so the device appears at the same path inside the sandbox. Only
absolute canonical paths under `/dev/` are accepted: relative paths, paths
elsewhere (for example `/etc/shadow`), traversal such as `/dev/../etc/shadow`,
and bare `/dev` are rejected as invalid config.

CUDA needs a second option. `nvidia-smi` works with only `allowDevices`, but
during `cuInit` `libcuda` opens an `AF_UNIX`/`SOCK_SEQPACKET` socket to
`/tmp/nvidia-mps/control`, and the seccomp layer blocks that call with `EPERM`.
Setting `network.allowAllUnixSockets: true` makes the runtime skip
`apply-seccomp` entirely: Unix-socket creation and `io_uring` are no longer
blocked, and the nested PID/mount namespace that helper creates is not used
(bubblewrap's own `--unshare-pid` and fresh `/proc` still apply). The plugin
warns at load time when `allowDevices` is set without it. Like `allowDevices`,
this is Linux-only and opt-in.

> **Security note:** `allowAllUnixSockets` disables the Unix-socket blocking
> layer, which exposes host sockets such as `/run/docker.sock`. Docker socket
> access is effectively root-equivalent on many hosts. To compensate, when
> `allowAllUnixSockets` is enabled the plugin automatically appends `denyRead`
> masks for high-risk socket paths: Docker, Podman, containerd and CRI-O
> sockets, `$XDG_RUNTIME_DIR` (including the user bus and keyring/agent
> sockets), the SSH agent socket (`$SSH_AUTH_SOCK`), systemd
> private/journal sockets, the system D-Bus socket, and `/tmp/.X11-unix` /
> `/tmp/.ICE-unix`. The masks are added on Linux only, without replacing a
> user-supplied `denyRead` list.
>
> `/run/nvidia-persistenced/socket` and the NVIDIA device nodes are
> intentionally **not** masked, so CUDA and `nvidia-smi` keep working. If a
> trusted workflow needs one of the masked paths, `allowRead` can re-allow it
> (`allowRead` takes precedence over `denyRead`). Masking is
> defense-in-depth, not a guarantee: filesystem and network-domain rules still
> apply, and a reachable socket is still governed by its own file permissions.
> Use this option only for projects that need GPU compute and whose commands
> you trust.

> **Security note:** Every allowed device widens the sandbox. Exposed kernel
> drivers become attack surface, and a GPU made available this way gives the
> agent GPU compute (and whatever it can reach through that driver). Filesystem
> and network rules still apply, but they do not constrain what a device driver
> exposes. Leave it off unless a workload genuinely needs the device.

This option depends on the Bun patch to `@anthropic-ai/sandbox-runtime` carried
in this fork (`patches/@anthropic-ai%2Fsandbox-runtime@0.0.76.patch`); the
upstream package does not emit `--dev-bind-try` for these paths.

Verify from inside an agent shell command:

```bash
nvidia-smi
```

`nvidia-smi` proves only that the driver nodes are visible; CUDA also needs the
`allowAllUnixSockets` setting described above. If `nvidia-smi` says it cannot
communicate with the driver, the device nodes are missing: check that the
runtime patch is applied (see [Maintenance](#maintenance)) and that the config
file being loaded is the one you edited.

To remove GPU support, delete `filesystem.allowDevices` and
`network.allowAllUnixSockets` from the active config (or delete the per-project
file) and restart OpenCode.

### Path precedence

Path precedence is inherited from `@anthropic-ai/sandbox-runtime`:

- Read: `allowRead` takes precedence over `denyRead`
- Write: `denyWrite` takes precedence over `allowWrite`

### Example: allow git commit signing with SSH public key

If your Git workflow needs to read a public key (for example `~/.ssh/id_ed25519.pub`) while keeping `~/.ssh` blocked by default, re-allow only that file:

```json
// ~/.config/opencode/sandbox.json
{
  "filesystem": {
    "denyRead": [
      "~/.ssh",
      "~/.gnupg",
      "~/.aws/credentials",
      "~/.azure",
      "~/.config/gcloud",
      "~/.config/gh",
      "~/.kube",
      "~/.docker/config.json",
      "~/.npmrc",
      "~/.netrc",
      "~/.env"
    ],
    "allowRead": ["~/.ssh/id_ed25519.pub"]
  }
}
```

### Example: Per-project config

```json
// ~/.config/opencode/projects/my-app.sandbox.json
{
  "network": {
    "allowedDomains": ["my-internal-api.company.com"]
  }
}
```

### Environment variables

`OPENCODE_SANDBOX_CONFIG` holds the configuration inline as a JSON string:

```bash
OPENCODE_SANDBOX_CONFIG='{"filesystem":{"denyRead":["~/.ssh"]},"network":{"allowedDomains":["github.com"]}}' opencode
```

`OPENCODE_SANDBOX_CONFIG_PATH` points at an existing JSON config file instead:

```bash
OPENCODE_SANDBOX_CONFIG_PATH=~/.config/opencode/sandbox.json opencode
```

Example allowing only the SSH public key to be read:

```bash
OPENCODE_SANDBOX_CONFIG='{"filesystem":{"denyRead":["~/.ssh","~/.gnupg","~/.aws/credentials","~/.azure","~/.config/gcloud","~/.config/gh","~/.kube","~/.docker/config.json","~/.npmrc","~/.netrc","~/.env"],"allowRead":["~/.ssh/id_ed25519.pub"]}}' opencode
```

### Disable

```bash
OPENCODE_DISABLE_SANDBOX=1 opencode
```

Or in any config file:

```json
{
  "disabled": true
}
```

### Toggle

The command palette offers **Toggle Sandbox**, which pauses and resumes sandboxing for the current project.

Paused state is stored per project under `~/.cache/opencode-sandbox/toggle/` and survives restarts. It automatically re-enables after 7 days, so a sandbox is never left paused indefinitely.

The status-bar badge reflects the current state: green `on`, yellow `paused`, subdued `off` — and updates immediately when toggled.

## Maintenance

### Update the plugin

Local directory installs are not update-checked. After `git pull`:

```bash
cd /path/to/opencode-sandbox-plugin
git pull
bun install      # reapplies patches/
bun run build
```

OpenCode watches `dist/`, so code changes hot-reload. Config changes and
runtime-patch changes need a full OpenCode restart: `SandboxManager.initialize()`
is process-global and runs once per server process, so a plugin hot-reload does
not re-read `sandbox.json` or reload the patched runtime module.

### The sandbox-runtime patch

This fork carries `patches/@anthropic-ai%2Fsandbox-runtime@0.0.76.patch`, wired
through `patchedDependencies` in `package.json` and `bun.lock`. It adds
`filesystem.allowDevices` to the runtime:

- `FilesystemConfigSchema` accepts the key.
- `wrapWithSandbox` forwards the per-call/global device list to the Linux
  wrapper.
- After bwrap's `--dev /dev`, each device is mounted with
  `--dev-bind-try <path> <path>`.
- The runtime accepts only absolute canonical paths under `/dev/`; the plugin
  applies the same validation before the runtime sees the list.
- The TypeScript declarations are updated for the new field.

The patch is pinned to exactly `0.0.76` (`^0.0.76` resolves to `0.0.76` for
`0.0.x`). If you deliberately upgrade the runtime, regenerate the patch instead
of editing `node_modules` by hand:

```bash
# bump and install the new dependency first
bun add @anthropic-ai/sandbox-runtime@<version>
bun install

# reapply the same edits in node_modules/@anthropic-ai/sandbox-runtime,
# then commit them as the patch for that version
bun patch @anthropic-ai/sandbox-runtime@<version>
bun patch --commit 'node_modules/@anthropic-ai/sandbox-runtime'

bun test
bun run build
```

The patch filename includes the exact version, so upgrading produces
`patches/@anthropic-ai%2Fsandbox-runtime@<version>.patch` and a matching
`patchedDependencies` entry.

A missing or outdated patch fails silently for GPU users: the unpatched zod
schema strips `filesystem.allowDevices`, the sandbox starts without the device
nodes, and `nvidia-smi` reports that it cannot communicate with the driver.
Verify the patch is applied:

```bash
grep -R "allowDevices" \
  node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/{sandbox-config.js,sandbox-manager.js,linux-sandbox-utils.js}
bun test
```

### Verify the live plugin

- Server log: a `loading plugin` line with this checkout's `dist/index.js`.
- TUI: the `⊙ sandbox: on` badge.
- Fail-closed check: writing to `$HOME` should fail with
  `Read-only file system`.
- GPU: `nvidia-smi` inside an agent shell command, plus a CUDA workload (see
  [Linux device passthrough](#linux-device-passthrough)).

### Remove GPU support or the patch

1. Remove `filesystem.allowDevices` and `network.allowAllUnixSockets` from the
   active config (or delete the per-project file) and restart OpenCode.
2. To drop the runtime patch entirely:

```bash
rm patches/@anthropic-ai%2Fsandbox-runtime@0.0.76.patch
# delete the "patchedDependencies" block from package.json
bun install
bun run build
```

`bun install` rewrites `bun.lock` without the patch. If `package.json` and
`bun.lock` have no other local changes, `git checkout -- package.json bun.lock`
also works. Without the patch, `filesystem.allowDevices` is ignored by the
runtime, so remove it from the config as well. The AppArmor profile from
[Linux prerequisites](#linux-prerequisites) is independent and can stay, or be
removed with the commands shown there.

### Local-path caveat

This install points OpenCode at a local directory. If that directory is moved
or deleted, the plugin cannot load and agent commands run **unsandboxed**
(logged as a plugin load error). Keep the checkout at a stable path and check
the server log after moving it.

## How it works

The plugin hooks the shell creation path, which OpenCode invokes for every command the agent runs:

1. The command is wrapped with `SandboxManager.wrapWithSandbox()` — OS-level filesystem and network restrictions around the process tree.
2. The shell binary is swapped for a tiny shim (`~/.cache/opencode-sandbox/shim/`, or `$XDG_CACHE_HOME` when set) that executes the wrapped command through the original shell.

The command string itself is left untouched, so OpenCode's built-in permission rules, shell-safety scanning and directory authorization all evaluate the real command.

Every shell OpenCode creates programmatically is covered — the shell tool and session shells. Interactive TUI terminals are spawned outside this path and are not sandboxed. Sandbox mount points are cleaned up when OpenCode reports the shell has ended, including interrupted and timed-out commands.

A TUI entrypoint (`exports["./tui"]`, built to `dist/tui.js`) adds a status-bar badge (`⊙ sandbox: on`) to the home and session footers, reflecting the sandbox state including palette toggles (see [Toggle](#toggle)). Enabling/disabling the `opencode-sandbox` plugin toggles the badge, the palette command and the sandbox together.

```
Agent → shell → [sandboxed execution] → Agent
```

The AI model interprets sandbox errors (like "Read-only file system" or "Connection blocked") directly from command output — no additional annotation layer needed.

Sandbox initialization is deferred until the first command, so the plugin does not interfere with OpenCode startup. Plugin diagnostics go to the OpenCode server log, prefixed with `[opencode-sandbox]`. Sandbox violations are correlated with each individual command, including concurrent or repeated ones.

### Windows status

`@anthropic-ai/sandbox-runtime` supports Windows through an argv-and-environment API that OpenCode's plugin interfaces do not expose. Until they can be connected safely, the plugin blocks Windows commands.

### Failure behavior

If sandbox initialization or wrapping fails, the affected command is blocked.

## Related

- [@anthropic-ai/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) — The underlying sandbox engine
- [OpenCode Plugins Docs](https://opencode.ai/v2/docs/build/plugins) — How to create and use plugins
- [Claude Code Sandboxing](https://docs.claude.com/en/docs/claude-code/sandboxing) — Anthropic's sandboxing documentation
