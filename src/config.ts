import { realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"

export interface SandboxPluginConfig {
  disabled?: boolean
  mode?: "permissive" | "enforce"
  environment?: Record<string, string>
  filesystem?: {
    denyRead?: string[]
    allowRead?: string[]
    allowWrite?: string[]
    denyWrite?: string[]
    allowDevices?: string[]
  }
  network?: {
    allowedDomains?: string[]
    deniedDomains?: string[]
    allowUnixSockets?: string[]
    allowAllUnixSockets?: boolean
    allowLocalBinding?: boolean
  }
}

const DEFAULT_DENY_READ_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws/credentials",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".kube",
  ".docker/config.json",
  ".npmrc",
  ".netrc",
  ".env",
]

/** High-risk Unix sockets that become reachable when the runtime's seccomp
 * socket filter is disabled by `allowAllUnixSockets`. Docker socket access is
 * effectively root-equivalent on many hosts, so these are masked by default.
 * NVIDIA device nodes and `/run/nvidia-persistenced/socket` are intentionally
 * absent so GPU passthrough keeps working.
 *
 * Existing paths are canonicalized because bwrap cannot create a `/dev/null`
 * file bind over a destination that traverses a symlinked directory: on a
 * typical Linux host `/var/run` is a symlink to `/run`, and masking
 * `/var/run/docker.sock` aborts the whole command ("Can't create file at
 * /var/run/docker.sock"). Absent paths are kept verbatim; the runtime skips
 * them, and keeping them here makes the configured deny list predictable. */
function riskyUnixSocketPaths(): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR ?? (uid !== undefined ? `/run/user/${uid}` : undefined)
  const sshAgent = process.env.SSH_AUTH_SOCK
  const candidates = [
    "/run/docker.sock",
    "/var/run/docker.sock",
    "/run/podman/podman.sock",
    "/run/containerd/containerd.sock",
    "/run/crio/crio.sock",
    "/run/systemd/private",
    "/run/systemd/journal/socket",
    "/run/dbus/system_bus_socket",
    "/tmp/.X11-unix",
    "/tmp/.ICE-unix",
    runtimeDir,
    sshAgent,
  ]
  return [
    ...new Set(
      candidates
        .filter((p): p is string => !!p && p.startsWith("/"))
        .map((p) => {
          try {
            return realpathSync(p)
          } catch {
            return p
          }
        }),
    ),
  ]
}

const DEFAULT_ALLOWED_DOMAINS = [
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "*.pypi.org",
  "crates.io",
  "*.crates.io",
  "github.com",
  "*.github.com",
  "gitlab.com",
  "*.gitlab.com",
  "bitbucket.org",
  "*.bitbucket.org",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "*.googleapis.com",
]

const UNSAFE_WRITE_PATHS = new Set([
  "/",
  "/home",
  "/usr",
  "/etc",
  "/var",
  "/opt",
  "/Library",
  "/System",
  "/private",
  "/Volumes",
  "/Users",
])

function isSafeWritePath(p: string): boolean {
  const normalized = path.resolve(p)
  if (UNSAFE_WRITE_PATHS.has(normalized)) {
    console.warn(`[opencode-sandbox] Rejecting unsafe write path: ${normalized}`)
    return false
  }
  return true
}

// Expands ${directory}, ${worktree} and ${tmpdir}. Drops the entry if a variable is
// unknown, empty or unsafe; ${name:force} skips the safety check for that variable.
function expandWritePath(entry: string, vars: Record<string, string>): string | null {
  let dropped = false
  const expanded = entry.replace(/\$\{(\w+)(:force)?\}/g, (match, name: string, force?: string) => {
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined
    if (value === undefined)
      console.warn(`[opencode-sandbox] Unknown variable ${match} in allowWrite`)
    if (!value || (!force && !isSafeWritePath(value))) dropped = true
    return value ?? match
  })
  return dropped ? null : expanded
}

export function resolveConfig(
  projectDir: string,
  worktree: string,
  user?: SandboxPluginConfig,
): SandboxRuntimeConfig {
  const homeDir = os.homedir()

  const vars = { directory: projectDir, worktree, tmpdir: os.tmpdir() }
  // biome-ignore lint/suspicious/noTemplateCurlyInString: allowWrite variables
  const entries = user?.filesystem?.allowWrite ?? ["${directory}", "${worktree}", "${tmpdir}"]
  const seen = new Set<string>()
  const writePaths = entries
    .map((entry) => expandWritePath(entry, vars))
    .filter((p): p is string => {
      if (p === null) return false
      const resolved = path.resolve(p)
      if (seen.has(resolved)) return false
      seen.add(resolved)
      return true
    })

  const userAllowDevices = user?.filesystem?.allowDevices
  const baseDenyRead =
    user?.filesystem?.denyRead ?? DEFAULT_DENY_READ_DIRS.map((p) => path.join(homeDir, p))
  // CUDA cannot open its socket through the runtime's seccomp filter, so GPU
  // support requires allowAllUnixSockets. That removes the syscall-level
  // socket block, so mask the host sockets that would otherwise become
  // reachable. Fails closed only in the sense that masks can only be added.
  const denyRead =
    process.platform === "linux" && user?.network?.allowAllUnixSockets === true
      ? [...new Set([...baseDenyRead, ...riskyUnixSocketPaths()])]
      : baseDenyRead

  return {
    filesystem: {
      denyRead,
      allowRead: user?.filesystem?.allowRead ?? [],
      allowWrite: writePaths,
      denyWrite: user?.filesystem?.denyWrite ?? [],
      allowDevices: userAllowDevices
        ? [...new Set(userAllowDevices.map((p) => path.resolve(p)))]
        : [],
    },
    network: {
      allowedDomains: user?.network?.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS,
      deniedDomains: user?.network?.deniedDomains ?? [],
      allowUnixSockets: user?.network?.allowUnixSockets,
      allowAllUnixSockets: user?.network?.allowAllUnixSockets,
      allowLocalBinding: user?.network?.allowLocalBinding ?? false,
    },
  }
}

export function getConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdgConfig, "opencode-sandbox")
}

const FILESYSTEM_KEYS = new Set([
  "denyRead",
  "allowRead",
  "allowWrite",
  "denyWrite",
  "allowDevices",
])
const NETWORK_KEYS = new Set([
  "allowedDomains",
  "deniedDomains",
  "allowUnixSockets",
  "allowAllUnixSockets",
  "allowLocalBinding",
])

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Structural validation of a loaded config.
 *
 * `errors` are conditions the plugin cannot interpret as written; the caller
 * logs them so a weakened configuration is at least visible. `warnings` cover
 * unknown keys, which may be written for a newer plugin version. */
export function validateConfig(config: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isObject(config)) return { errors: ["config must be a JSON object"], warnings }

  for (const [key, value] of Object.entries(config)) {
    if (key === "disabled" || key === "mode") {
      if (key === "disabled" && typeof value !== "boolean") {
        errors.push("disabled must be a boolean")
      } else if (key === "mode" && value !== "permissive" && value !== "enforce") {
        errors.push('mode must be "permissive" or "enforce"')
      }
    } else if (key === "environment") {
      if (!isObject(value)) {
        errors.push("environment must be a JSON object")
      } else {
        for (const [name, envValue] of Object.entries(value)) {
          if (typeof envValue !== "string") {
            errors.push(`environment.${name} must be a string`)
          }
        }
      }
    } else if (key === "filesystem" || key === "network") {
      const knownKeys = key === "filesystem" ? FILESYSTEM_KEYS : NETWORK_KEYS
      if (!isObject(value)) {
        errors.push(`${key} must be a JSON object`)
        continue
      }
      for (const [subKey, subValue] of Object.entries(value)) {
        if (!knownKeys.has(subKey)) {
          warnings.push(`ignoring unknown key "${key}.${subKey}"`)
        } else if (subKey === "allowAllUnixSockets" || subKey === "allowLocalBinding") {
          if (typeof subValue !== "boolean") errors.push(`${key}.${subKey} must be a boolean`)
        } else if (subKey === "allowDevices") {
          if (!isStringArray(subValue)) {
            errors.push(`${key}.${subKey} must be an array of strings`)
          } else {
            for (const device of subValue) {
              if (!device.startsWith("/dev/") || path.resolve(device) !== device) {
                errors.push(
                  `${key}.${subKey} entries must be absolute canonical paths under /dev/ (got "${device}")`,
                )
              }
            }
          }
        } else if (!isStringArray(subValue)) {
          errors.push(`${key}.${subKey} must be an array of strings`)
        }
      }
    } else {
      warnings.push(`ignoring unknown key "${key}"`)
    }
  }

  // Cross-field warning: CUDA on Linux opens an AF_UNIX/SOCK_SEQPACKET socket
  // during cuInit, which the runtime's seccomp layer blocks unless socket
  // filtering is disabled. Device access alone is enough for nvidia-smi.
  const allowDevices = isObject(config.filesystem) ? config.filesystem.allowDevices : undefined
  const network = isObject(config.network) ? config.network : undefined
  if (
    isStringArray(allowDevices) &&
    allowDevices.length > 0 &&
    network?.allowAllUnixSockets !== true
  ) {
    warnings.push(
      "filesystem.allowDevices grants device access, but CUDA on Linux also needs network.allowAllUnixSockets: true (the seccomp layer blocks the AF_UNIX/SOCK_SEQPACKET socket libcuda opens); enabling it disables Unix-socket blocking",
    )
  }

  return { errors, warnings }
}

function checkedConfig(config: SandboxPluginConfig): SandboxPluginConfig {
  const { errors, warnings } = validateConfig(config)
  for (const message of [...errors, ...warnings]) {
    console.warn(`[opencode-sandbox] ${message}`)
  }
  return config
}

export function getOpenCodeConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdgConfig, "opencode")
}

export function isSandboxGloballyDisabled(): boolean {
  return (
    process.env.OPENCODE_DISABLE_SANDBOX === "1" || process.env.OPENCODE_DISABLE_SANDBOX === "true"
  )
}

async function tryLoadJsonFile(filePath: string): Promise<SandboxPluginConfig | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    return JSON.parse(content) as SandboxPluginConfig
  } catch {
    return null
  }
}

export async function loadConfig(projectDir: string): Promise<SandboxPluginConfig> {
  const envConfig = process.env.OPENCODE_SANDBOX_CONFIG
  if (envConfig) {
    try {
      return checkedConfig(JSON.parse(envConfig) as SandboxPluginConfig)
    } catch {
      console.warn("[opencode-sandbox] Invalid JSON in OPENCODE_SANDBOX_CONFIG, using defaults")
    }
  }

  const envConfigPath = process.env.OPENCODE_SANDBOX_CONFIG_PATH
  if (envConfigPath) {
    const customConfig = await tryLoadJsonFile(envConfigPath)
    if (customConfig) return checkedConfig(customConfig)
    console.warn(
      `[opencode-sandbox] Failed to load config from OPENCODE_SANDBOX_CONFIG_PATH: ${envConfigPath}`,
    )
  }

  const standardProjectConfig = await tryLoadJsonFile(
    path.join(projectDir, ".opencode", "sandbox.json"),
  )
  if (standardProjectConfig) return checkedConfig(standardProjectConfig)

  const configDir = getConfigDir()

  const projectName = path.basename(projectDir)
  const projectConfig = await tryLoadJsonFile(
    path.join(configDir, "projects", `${projectName}.json`),
  )
  if (projectConfig) return checkedConfig(projectConfig)

  const standardGlobalConfig = await tryLoadJsonFile(
    path.join(getOpenCodeConfigDir(), "sandbox.json"),
  )
  if (standardGlobalConfig) return checkedConfig(standardGlobalConfig)

  const globalConfig = await tryLoadJsonFile(path.join(configDir, "config.json"))
  if (globalConfig) return checkedConfig(globalConfig)

  return {}
}
