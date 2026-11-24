import { Plugin } from "@opencode/plugin/tui"
import { isSandboxGloballyDisabled, loadConfig } from "./config"

// Same id as the server part, so enabling/disabling "opencode-sandbox"
// controls the TUI badge together with the sandbox.
export default Plugin.define({
  id: "opencode-sandbox",
  async setup(ctx) {
    if (isSandboxGloballyDisabled()) return

    const directory = ctx.location?.directory ?? ctx.data.location.default().directory
    const config = await loadConfig(directory)
    const status = config.disabled ? "off" : "on"
    const color = status === "on" ? ctx.theme.text.feedback.success.base : ctx.theme.text.muted

    const Badge = () => (
      <box flexDirection="row" flexShrink={0}>
        <text fg={color}>{`⊙ sandbox: ${status}`}</text>
      </box>
    )

    const dispose = [
      ctx.ui.slot({ append: "home.footer.status", render: Badge }),
      ctx.ui.slot({ append: "prompt.footer.status", render: Badge }),
    ]

    return () => {
      for (const claim of dispose) claim()
    }
  },
})
