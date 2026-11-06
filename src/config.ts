import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"

export interface SandboxPluginConfig {
  disabled?: boolean
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
            return fs.realpathSync(p)
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

/** Resolve a user-supplied path relative to projectDir if it is not
 * absolute and does not start with ~ (which the runtime expands). */
function resolveUserPath(p: string, projectDir: string): string {
  if (p.startsWith("/") || p.startsWith("~")) return p
  return path.resolve(projectDir, p)
}

export function resolveConfig(
  projectDir: string,
  worktree: string,
  user?: SandboxPluginConfig,
): SandboxRuntimeConfig {
  // macOS resolves symlinks before applying sandbox filters, so relative
  // globs and projectDir-anchored rules must be built from the canonical
  // path or the profile will not match.
  let canonicalProjectDir: string
  try {
    canonicalProjectDir = fs.realpathSync(projectDir)
  } catch {
    canonicalProjectDir = path.resolve(projectDir)
  }

  const homeDir = os.homedir()

  const candidatePaths = [projectDir, worktree, os.tmpdir()].filter(Boolean)
  const safePaths = candidatePaths.filter((p) => isSafeWritePath(p))
  const writePaths = user?.filesystem?.allowWrite
    ? user.filesystem.allowWrite.map((p) => resolveUserPath(p, canonicalProjectDir))
    : [...new Set(safePaths.map((p) => path.resolve(p)))]

  const userDenyRead = user?.filesystem?.denyRead
  const userAllowRead = user?.filesystem?.allowRead
  const userDenyWrite = user?.filesystem?.denyWrite
  const userAllowDevices = user?.filesystem?.allowDevices

  const baseDenyRead = userDenyRead
    ? userDenyRead.map((p) => resolveUserPath(p, canonicalProjectDir))
    : DEFAULT_DENY_READ_DIRS.map((p) => path.join(homeDir, p))
  const denyRead =
    process.platform === "linux" && user?.network?.allowAllUnixSockets === true
      ? [...new Set([...baseDenyRead, ...riskyUnixSocketPaths()])]
      : baseDenyRead

  return {
    filesystem: {
      denyRead,
      allowRead: userAllowRead
        ? userAllowRead.map((p) => resolveUserPath(p, canonicalProjectDir))
        : [],
      allowWrite: writePaths,
      denyWrite: userDenyWrite
        ? userDenyWrite.map((p) => resolveUserPath(p, canonicalProjectDir))
        : [],
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

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Structural validation of a loaded config.
 *
 * `errors` are conditions the plugin cannot interpret safely — the caller must
 * block commands rather than fall through to weaker defaults. `warnings` cover
 * unknown keys, which may be written for a newer plugin version and are
 * ignored without blocking. */
export function validateConfig(config: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isObject(config)) return { errors: ["config must be a JSON object"], warnings }

  for (const [key, value] of Object.entries(config)) {
    if (key === "disabled") {
      if (typeof value !== "boolean") errors.push("disabled must be a boolean")
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

/** Apply validation to a parsed config, throwing on structural errors so the
 * caller fails closed instead of silently weakening to defaults. */
function checkedConfig(source: string, config: unknown): SandboxPluginConfig {
  const { errors, warnings } = validateConfig(config)
  for (const warning of warnings) console.warn(`[opencode-sandbox] ${source}: ${warning}`)
  if (errors.length > 0) throw new Error(`Invalid config (${source}): ${errors.join("; ")}`)
  return config as SandboxPluginConfig
}

export function isSandboxGloballyDisabled(): boolean {
  return (
    process.env.OPENCODE_DISABLE_SANDBOX === "1" || process.env.OPENCODE_DISABLE_SANDBOX === "true"
  )
}

/** Read and parse a config file. Missing files (ENOENT) return null so the
 * search continues; a file that exists but cannot be read or parsed throws so
 * the caller fails closed rather than skipping a restriction the user set. */
async function readJsonConfig(filePath: string): Promise<unknown> {
  let content: string
  try {
    content = await fsPromises.readFile(filePath, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new Error(`Cannot read config file ${filePath}: ${messageOf(err)}`)
  }
  try {
    return JSON.parse(content)
  } catch (err) {
    throw new Error(`Invalid JSON in config file ${filePath}: ${messageOf(err)}`)
  }
}

export async function loadConfig(projectDir: string): Promise<SandboxPluginConfig> {
  const envConfig = process.env.OPENCODE_SANDBOX_CONFIG
  if (envConfig) {
    let parsed: unknown
    try {
      parsed = JSON.parse(envConfig)
    } catch (err) {
      throw new Error(`Invalid JSON in OPENCODE_SANDBOX_CONFIG: ${messageOf(err)}`)
    }
    return checkedConfig("OPENCODE_SANDBOX_CONFIG", parsed)
  }

  const envConfigPath = process.env.OPENCODE_SANDBOX_CONFIG_PATH
  if (envConfigPath) {
    const customConfig = await readJsonConfig(envConfigPath)
    if (customConfig !== null) {
      return checkedConfig(`OPENCODE_SANDBOX_CONFIG_PATH (${envConfigPath})`, customConfig)
    }
    console.warn(
      `[opencode-sandbox] Failed to load config from OPENCODE_SANDBOX_CONFIG_PATH: ${envConfigPath}`,
    )
  }

  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  const legacyDir = path.join(configBase, "opencode-sandbox")
  const standardDir = path.join(configBase, "opencode")
  const projectName = path.basename(projectDir)

  const sources = [
    path.join(standardDir, "projects", `${projectName}.sandbox.json`),
    path.join(legacyDir, "projects", `${projectName}.json`),
    path.join(standardDir, "sandbox.json"),
    path.join(legacyDir, "config.json"),
  ]

  for (const source of sources) {
    const config = await readJsonConfig(source)
    if (config !== null) return checkedConfig(source, config)
  }

  return {}
}
