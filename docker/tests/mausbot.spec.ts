import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GUARD_MARKER,
  installStdoutGuard,
  stripImportFromNodeOptions,
} from '../mausbot/acp-stdout-guard.mjs'
import {
  buildInitialOpenMausBotConfig,
  formatModelEnv,
  resolveDefaultModelId,
  seedOpenMausBotConfig,
  shellQuote,
  writeModelEnv,
} from '../mausbot/seed-openmausbot.mjs'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mausbot-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('seed-openmausbot', () => {
  it('selects spark/<MODEL_ID> when MODEL_BASE_URL is configured', () => {
    expect(resolveDefaultModelId({
      MODEL_BASE_URL: 'https://example.invalid/v1',
      MODEL_ID: 'solar-pro2',
    })).toBe('spark/solar-pro2')
  })

  it('falls back to deepseek-official when MODEL_BASE_URL is absent', () => {
    expect(resolveDefaultModelId({})).toBe('deepseek-official/deepseek-v4-flash')
    expect(resolveDefaultModelId({ MODEL_ID: 'deepseek-v4-pro' })).toBe('deepseek-official/deepseek-v4-pro')
  })

  it('builds an OpenMausBot config with deepseek wrapper and zero secrets', () => {
    const cfg = buildInitialOpenMausBotConfig({
      MODEL_BASE_URL: 'https://api.example.invalid/v1',
      MODEL_ID: 'my-model',
      MODEL_API_KEY: 'super-secret-do-not-write',
      DEEPSEEK_API_KEY: 'sk-also-secret',
      OMB_SERVER_NAME: 'My Haven Box',
    })

    expect(cfg.computerName).toBe('My Haven Box')
    expect(cfg.defaultModelSelection).toEqual({ instanceId: 'deepseek', model: 'spark/my-model' })
    expect(cfg.newBotDefaults.profile.modelSelection).toEqual({ instanceId: 'deepseek', model: 'spark/my-model' })
    expect(cfg.instances.deepseek).toEqual({
      driver: 'deepseekAgent',
      displayName: 'Haven Web3 (dsh)',
      icon: { kind: 'preset', preset: 'deepseek' },
      config: { cli: '/opt/agent/dsh-acp-wrapper.sh' },
      environment: { DSH_HOME: '/data/dsh' },
    })
    // Keeps PRODUCT_FLEET_ADDITIONS alive in OpenMausBot Settings.
    expect(cfg.instances.claude?.driver).toBe('claudeAgent')
    expect(cfg.instances.codex?.driver).toBe('codex')
    expect(cfg.instances.grok?.driver).toBe('grokAgent')

    const serialized = JSON.stringify(cfg)
    expect(serialized).not.toContain('super-secret-do-not-write')
    expect(serialized).not.toContain('sk-also-secret')
  })

  it('seeds config.json once and preserves existing user edits', () => {
    const dir = makeTempDir()
    const first = seedOpenMausBotConfig(dir, {
      MODEL_BASE_URL: 'https://example.invalid/v1',
      MODEL_ID: 'first-model',
    })
    expect(first.created).toBe(true)
    expect(existsSync(first.path)).toBe(true)

    writeFileSync(first.path, '{"computerName":"User Edited"}\n')
    const second = seedOpenMausBotConfig(dir, {
      MODEL_BASE_URL: 'https://example.invalid/v1',
      MODEL_ID: 'second-model',
    })
    expect(second.created).toBe(false)
    expect(readFileSync(first.path, 'utf8')).toBe('{"computerName":"User Edited"}\n')
  })

  it('safely single-quotes model env vars with shell metacharacters', () => {
    expect(shellQuote(`a'b$c"d\`e`)).toBe(`'a'\\''b$c"d\`e'`)
    const text = formatModelEnv({
      MODEL_BASE_URL: 'https://example.invalid/v1',
      MODEL_ID: 'org/model:free',
      MODEL_API_KEY: `sk-test'$100`,
    })
    expect(text).toContain(`MODEL_BASE_URL='https://example.invalid/v1'`)
    expect(text).toContain(`MODEL_ID='org/model:free'`)
    expect(text).toContain(`MODEL_API_KEY='sk-test'\\''$100'`)

    const dir = makeTempDir()
    const envPath = join(dir, 'model.env')
    expect(writeModelEnv(envPath, { MODEL_ID: 'test-model' })).toBe(true)
    expect(readFileSync(envPath, 'utf8')).toBe(`MODEL_ID='test-model'\n`)
    expect(writeModelEnv(join(dir, 'empty.env'), {})).toBe(false)
  })
})

describe('acp-stdout-guard', () => {
  it('strips only the guard import flag from NODE_OPTIONS', () => {
    expect(stripImportFromNodeOptions(`${GUARD_MARKER} --max-old-space-size=4096`)).toBe('--max-old-space-size=4096')
    expect(stripImportFromNodeOptions(`--trace-warnings ${GUARD_MARKER}`)).toBe('--trace-warnings')
    expect(stripImportFromNodeOptions(GUARD_MARKER)).toBe('')
    expect(stripImportFromNodeOptions('')).toBe('')
  })

  it('routes console.log/info/debug/dir/table to console.error and cleans NODE_OPTIONS', () => {
    const stderrCalls: unknown[][] = []
    const fakeConsole = {
      log: () => { throw new Error('stdout should not be called') },
      info: () => { throw new Error('stdout should not be called') },
      debug: () => { throw new Error('stdout should not be called') },
      dir: () => { throw new Error('stdout should not be called') },
      table: () => { throw new Error('stdout should not be called') },
      error: (...args: unknown[]) => { stderrCalls.push(args) },
    }
    const fakeEnv: Record<string, string | undefined> = {
      NODE_OPTIONS: `${GUARD_MARKER} --max-old-space-size=2048`,
    }

    installStdoutGuard(fakeConsole as unknown as Console, fakeEnv)
    fakeConsole.log('[prowlarr]', 'hello')
    fakeConsole.info('info-msg')
    fakeConsole.debug('debug-msg')

    expect(stderrCalls).toEqual([
      ['[prowlarr]', 'hello'],
      ['info-msg'],
      ['debug-msg'],
    ])
    expect(fakeEnv.NODE_OPTIONS).toBe('--max-old-space-size=2048')
  })
})
