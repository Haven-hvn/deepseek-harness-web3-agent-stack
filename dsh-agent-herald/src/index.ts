/**
 * dsh-agent-herald — the Herald sovereign release agent.
 *
 * This plugin is identity, not machinery: it reads the agent definition
 * (`soul.md`, `process.md`, `workflow.md`,
 * `reference/aol-protocol.md`) and registers each as a system-prompt
 * section (the tool-bash pattern), so every model step runs as
 * Herald — a publisher that earns its keep releasing files whose
 * decryption is earned through ownership.
 *
 * Sections render before the deployment persona prefix (orders -500 /
 * -400 / -350 / -300 vs harness identity -1000 and persona prefix 0):
 * identity first, then deployment instructions, then first-party
 * guidance.
 *
 * Fail-loud: a missing doc throws at apply — an agent must never boot
 * without its soul.
 *
 * @module dsh-agent-herald
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'agent-herald'

/** The prompt registry must be present: sections are the whole product. */
export const inject = ['systemPrompt'] as const

/** No configuration: the docs are the config. */
export const Config = z.object({})

/** Prompt sections this plugin owns, in render order. */
export const SECTIONS = [
  { name: 'agent:soul', order: -500, file: 'soul.md' },
  { name: 'agent:process', order: -400, file: 'process.md' },
  { name: 'agent:workflow', order: -350, file: 'workflow.md' },
  { name: 'agent:aol-protocol', order: -300, file: 'reference/aol-protocol.md' },
] as const

/** Package root: one up from `lib/` at runtime or `src/` under test. */
export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Load one agent doc, failing loud when it is missing or empty.
 * @param relativePath - doc path under the package root.
 * @param baseDir - override for tests (defaults to the package root).
 * @returns the doc text.
 */
export function loadAgentDoc(relativePath: string, baseDir: string = packageRoot()): string {
  const path = join(baseDir, relativePath)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    throw new Error(`dsh-agent-herald: cannot boot without ${relativePath} (missing: ${path})`, { cause: error })
  }
  if (text.trim() === '') {
    throw new Error(`dsh-agent-herald: cannot boot with an empty ${relativePath}`)
  }
  return text
}

/**
 * Register the agent definition as prompt sections.
 * @param ctx - Plugin context carrying the prompt registry.
 */
export function apply(ctx: Context): void {
  for (const section of SECTIONS) {
    const text = loadAgentDoc(section.file)
    ctx.systemPrompt.section({ name: section.name, order: section.order, text })
  }
}
