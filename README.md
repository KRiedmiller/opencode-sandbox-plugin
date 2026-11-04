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

If `XDG_CONFIG_HOME` is set, it is used instead of `~/.config`.

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
