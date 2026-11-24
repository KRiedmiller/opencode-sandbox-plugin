import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Mock the TUI plugin SDK: define() is an identity function in tests.
mock.module("@opencode/plugin/tui", () => ({
  Plugin: { define: (plugin: unknown) => plugin },
}))

// Stub the JSX runtime: rendering produces plain { type, props } trees so
// tests can assert on the badge content without a renderer.
const fakeJsx = (type: unknown, props: Record<string, unknown>) => ({ type, props })
mock.module("@opentui/solid/jsx-runtime", () => ({
  jsx: fakeJsx,
  jsxs: fakeJsx,
  Fragment: (props: { children?: unknown }) => props.children ?? null,
}))
mock.module("@opentui/solid/jsx-dev-runtime", () => ({
  jsxDEV: fakeJsx,
  Fragment: (props: { children?: unknown }) => props.children ?? null,
}))

const pluginModule = await import("../src/tui")

const theme = {
  text: {
    base: "#text-base",
    muted: "#text-muted",
    feedback: { success: { base: "#success", muted: "#success-muted" } },
  },
}

type Claim = { path: string; render: () => unknown; disposed: boolean }
type Element = { type: unknown; props: Record<string, unknown> }

const badgeOf = (claim: Claim) => claim.render() as Element
const labelOf = (claim: Claim) => JSON.stringify(badgeOf(claim))

const makeCtx = (directory = "/tmp/project", withLocation = true) => {
  const claims: Claim[] = []
  const ctx = {
    location: withLocation ? { directory } : undefined,
    data: {
      location: {
        default: () => ({ directory }),
      },
    },
    theme,
    ui: {
      slot: (claim: { append: string; render: () => unknown }) => {
        const entry: Claim = { path: claim.append, render: claim.render, disposed: false }
        claims.push(entry)
        return () => {
          entry.disposed = true
        }
      },
    },
  }
  return { ctx, claims }
}

describe("TUI plugin", () => {
  let testConfigHome: string | undefined
  let isolatedConfigHome: string | undefined

  beforeAll(() => {
    testConfigHome = process.env.XDG_CONFIG_HOME
    isolatedConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sandbox-tui-test-"))
    process.env.XDG_CONFIG_HOME = isolatedConfigHome
  })

  afterAll(() => {
    if (isolatedConfigHome) fs.rmSync(isolatedConfigHome, { force: true, recursive: true })
    if (testConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = testConfigHome
  })

  beforeEach(() => {
    delete process.env.OPENCODE_DISABLE_SANDBOX
    delete process.env.OPENCODE_SANDBOX_CONFIG
    delete process.env.OPENCODE_SANDBOX_CONFIG_PATH
  })

  test("exports the module shape: default { id, setup }", () => {
    expect(pluginModule.default.id).toBe("opencode-sandbox")
    expect(typeof pluginModule.default.setup).toBe("function")
  })

  test("registers no badge when OPENCODE_DISABLE_SANDBOX=1", async () => {
    process.env.OPENCODE_DISABLE_SANDBOX = "1"
    const { ctx, claims } = makeCtx()
    const cleanup = await pluginModule.default.setup(ctx)
    expect(claims).toHaveLength(0)
    expect(cleanup).toBeUndefined()
  })

  test("claims a status-bar badge on both footers", async () => {
    const { ctx, claims } = makeCtx()
    await pluginModule.default.setup(ctx)
    expect(claims.map((c) => c.path)).toEqual(["home.footer.status", "prompt.footer.status"])
  })

  test("default config shows the sandbox as on in success color", async () => {
    const { ctx, claims } = makeCtx()
    await pluginModule.default.setup(ctx)

    const badge = badgeOf(claims[0])
    expect(badge.type).toBe("box")
    const label = JSON.stringify(badge)
    expect(label).toContain("sandbox: on")
    expect(label).toContain("#success")
  })

  test("disabled config shows the plugin as off in muted color", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({ disabled: true })
    const { ctx, claims } = makeCtx()
    await pluginModule.default.setup(ctx)

    const label = labelOf(claims[0])
    expect(label).toContain("sandbox: off")
    expect(label).toContain("#text-muted")
  })

  test("falls back to the default location when ctx.location is unset", async () => {
    process.env.XDG_CONFIG_HOME = isolatedConfigHome ?? ""
    await fs.promises.mkdir(path.join(isolatedConfigHome ?? "", "opencode"), { recursive: true })
    await fs.promises.writeFile(
      path.join(isolatedConfigHome ?? "", "opencode", "sandbox.json"),
      JSON.stringify({ disabled: true }),
    )
    const { ctx, claims } = makeCtx("/tmp/other-project", false)
    await pluginModule.default.setup(ctx)
    expect(labelOf(claims[0])).toContain("sandbox: off")
    await fs.promises.rm(path.join(isolatedConfigHome ?? "", "opencode"), {
      recursive: true,
      force: true,
    })
  })

  test("cleanup disposes both slot claims", async () => {
    const { ctx, claims } = makeCtx()
    const cleanup = await pluginModule.default.setup(ctx)
    cleanup?.()
    expect(claims.every((claim) => claim.disposed)).toBe(true)
  })
})
