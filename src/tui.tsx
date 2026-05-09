/** @jsxImportSource @opentui/solid */
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { parse } from "comment-json"
import { createSignal, onCleanup, onMount } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

const CONFIG_FILENAME = "opencode-panel-apps.jsonc"
const DEFAULT_PERIOD_MS = 10_000
const MIN_PERIOD_MS = 1_000
const MAX_OUTPUT_LENGTH = 80
const MAX_BUFFER_LENGTH = 8_192

type PanelAppConfig = {
  icon: string
  command: string[]
  period: number
}

type PanelAppState = PanelAppConfig & {
  output: string
  status: "loading" | "ready" | "error"
}

function resolveConfigPath(api: TuiPluginApi) {
  const configuredDir = process.env.OPENCODE_CONFIG_DIR?.trim()
  const opencodeConfigPath = api.state.path.config
  const configDir = configuredDir || (
    extname(opencodeConfigPath) ? dirname(opencodeConfigPath) : opencodeConfigPath
  )

  return join(configDir, CONFIG_FILENAME)
}

function asPanelAppConfig(value: unknown): PanelAppConfig | undefined {
  if (!value || typeof value !== "object") return undefined

  const item = value as Record<string, unknown>
  if (typeof item.icon !== "string" || item.icon.trim() === "") return undefined
  if (!Array.isArray(item.command)) return undefined
  if (item.command.length === 0) return undefined
  if (!item.command.every((part) => typeof part === "string" && part.length > 0)) return undefined

  const period = typeof item.period === "number" && Number.isFinite(item.period)
    ? Math.max(MIN_PERIOD_MS, Math.floor(item.period))
    : DEFAULT_PERIOD_MS

  return {
    icon: item.icon,
    command: item.command,
    period,
  }
}

function readConfig(api: TuiPluginApi): PanelAppConfig[] {
  const configPath = resolveConfigPath(api)
  const raw = readFileSync(configPath, "utf8")
  const parsed = parse(raw) as Record<string, unknown>
  const apps = Array.isArray(parsed.apps) ? parsed.apps : []

  return apps.flatMap((app) => {
    const config = asPanelAppConfig(app)

    return config ? [config] : []
  })
}

function getFirstLine(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ""
}

function trimOutput(value: string) {
  if (value.length <= MAX_OUTPUT_LENGTH) return value

  return `${value.slice(0, MAX_OUTPUT_LENGTH - 1)}…`
}

function getTimeoutMs(period: number) {
  return Math.max(1_000, Math.min(5_000, Math.floor(period * 0.8)))
}

function runCommand(app: PanelAppConfig, cwd: string, timeoutMs: number, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const [command, ...args] = app.command
    let stdout = ""
    let stderr = ""
    let settled = false

    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      signal,
    })

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (error) {
        reject(error)
        return
      }

      const output = getFirstLine(stdout) || getFirstLine(stderr) || "ok"
      resolve(trimOutput(output))
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(new Error("timeout"))
    }, timeoutMs)

    signal.addEventListener("abort", () => {
      child.kill("SIGTERM")
      finish(new Error("aborted"))
    }, { once: true })

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(0, MAX_BUFFER_LENGTH)
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, MAX_BUFFER_LENGTH)
    })

    child.on("error", (error) => {
      finish(error)
    })

    child.on("close", (code) => {
      if (code === 0) {
        finish()
        return
      }

      const message = getFirstLine(stderr) || getFirstLine(stdout) || `exit ${code}`
      finish(new Error(trimOutput(message)))
    })
  })
}

function createInitialState(apps: PanelAppConfig[]): PanelAppState[] {
  return apps.map((app) => ({
    ...app,
    output: "loading…",
    status: "loading",
  }))
}

function SidebarContentView(props: { api: TuiPluginApi }) {
  const [apps, setApps] = createSignal<PanelAppState[]>([])
  const [configError, setConfigError] = createSignal<string | undefined>()
  const intervals: NodeJS.Timeout[] = []
  const inFlight = new Map<number, AbortController>()

  const setAppState = (index: number, patch: Partial<PanelAppState>) => {
    setApps((current) => current.map((app, appIndex) => (
      appIndex === index ? { ...app, ...patch } : app
    )))
  }

  const refreshApp = async (app: PanelAppConfig, index: number) => {
    if (inFlight.has(index)) return

    const controller = new AbortController()
    inFlight.set(index, controller)
    setAppState(index, { status: "loading" })

    try {
      const output = await runCommand(app, props.api.state.path.directory, getTimeoutMs(app.period), controller.signal)
      setAppState(index, { output, status: "ready" })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setAppState(index, {
        output: trimOutput(`error: ${message}`),
        status: "error",
      })
    } finally {
      inFlight.delete(index)
    }
  }

  onMount(() => {
    try {
      const config = readConfig(props.api)
      setApps(createInitialState(config))
      setConfigError(undefined)

      for (const [index, app] of config.entries()) {
        void refreshApp(app, index)
        intervals.push(setInterval(() => {
          void refreshApp(app, index)
        }, app.period))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setConfigError(trimOutput(message))
    }
  })

  onCleanup(() => {
    for (const interval of intervals) clearInterval(interval)
    for (const controller of inFlight.values()) controller.abort()
    inFlight.clear()
  })

  const theme = props.api.theme.current as typeof props.api.theme.current & {
    secondary?: string
    textMuted?: string
    error?: string
  }
  const muted = theme.textMuted ?? theme.secondary ?? theme.text
  const errorColor = theme.error ?? muted

  return (
    <box flexDirection="column" gap={0}>
      <text fg={props.api.theme.current.text}>
        <b>Panel Apps</b>
      </text>
      {configError() ? (
        <text fg={errorColor} wrapMode="none">⚠ - {configError()}</text>
      ) : apps().length === 0 ? (
        <text fg={muted} wrapMode="none">⏳ - No apps configured</text>
      ) : (
        apps().map((app) => (
          <text fg={app.status === "error" ? errorColor : muted} wrapMode="none">
            {app.icon} - {app.output}
          </text>
        ))
      )}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 600,
    slots: {
      sidebar_content() {
        return <SidebarContentView api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-panel-apps",
  tui,
}

export default plugin
