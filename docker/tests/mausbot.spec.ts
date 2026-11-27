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
    // Matches the one-hour DSH/ACP timers for slow local-model turns.
    expect(cfg.rooms).toEqual({ turnTimeoutMinutes: 60 })
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
      MODEL_CONTEXT_WINDOW: '65536',
      MODEL_MAX_OUTPUT_TOKENS: '32768',
      MODEL_REASONING_EFFORT: 'low',
    })
    expect(text).toContain(`MODEL_BASE_URL='https://example.invalid/v1'`)
    expect(text).toContain(`MODEL_ID='org/model:free'`)
    expect(text).toContain(`MODEL_API_KEY='sk-test'\\''$100'`)
    // Size/effort knobs must survive container recreation with the rest.
    expect(text).toContain(`MODEL_CONTEXT_WINDOW='65536'`)
    expect(text).toContain(`MODEL_MAX_OUTPUT_TOKENS='32768'`)
    expect(text).toContain(`MODEL_REASONING_EFFORT='low'`)
    // Local endpoints need no key; the entrypoint supplies a placeholder.
    expect(formatModelEnv({ MODEL_ID: 'bonsai27b' })).toBe(`MODEL_ID='bonsai27b'\n`)

    const dir = makeTempDir()
    const envPath = join(dir, 'model.env')
    expect(writeModelEnv(envPath, { MODEL_ID: 'test-model' })).toBe(true)
    expect(readFileSync(envPath, 'utf8')).toBe(`MODEL_ID='test-model'\n`)
    expect(writeModelEnv(join(dir, 'empty.env'), {})).toBe(false)
  })
})

describe('phone pairing & selectable local model', () => {
  it('forwards OMB_PUBLIC_URL to the pair CLI so phones get a link and QR', () => {
    const script = readFileSync(new URL('../mausbot/mausbot-pair.sh', import.meta.url), 'utf8')
    expect(script).toContain('--public-url "$OMB_PUBLIC_URL"')
    expect(script).toContain('openmausbot pair "$@"')
  })

  it('ships an lmstudio provider alongside spark in the ACP patch', () => {
    const patch = readFileSync(new URL('../mausbot/profile.acp.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('providers.lmstudio')
    expect(patch).toContain('process.env.LMSTUDIO_BASE_URL')
    expect(patch).toContain("process.env.LMSTUDIO_MODEL_ID || 'bonsai27b'")
    // The default model selection remains the configured spark endpoint.
    expect(patch).toContain("process.env.MODEL_BASE_URL ? 'spark' : 'deepseek-official'")
  })
})

describe('web3 harness profile & entrypoint contracts', () => {
  it('wires storage-synapse (with autoFund + pieceLedgerPath), haven-aol, and calibration USDFC in the ACP patch', () => {
    const patch = readFileSync(new URL('../mausbot/profile.acp.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('- id: storage-synapse')
    expect(patch).toContain('pieceLedgerPath: /data/synapse/pieces.json')
    expect(patch).toContain('autoFund: true')
    expect(patch).toContain('- id: haven-aol')
    expect(patch).toContain('keyStorePath: /data/haven-aol/keys.json')
    // wallet-tools must expose calibration USDFC instead of blanking tokens with `tokens: []`.
    expect(patch).not.toContain('tokens: []')
    expect(patch).toContain('0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0')
    expect(patch).toContain('token: USDFC')
  })

  it('creates and chowns persistent haven-aol and synapse state directories in entrypoint.sh', () => {
    const entry = readFileSync(new URL('../mausbot/entrypoint.sh', import.meta.url), 'utf8')
    expect(entry).toContain('/data/haven-aol')
    expect(entry).toContain('/data/synapse')
    expect(entry).toContain('calibration USDFC')
  })

  it('keeps the headless profile.patch.yml in sync for calibration USDFC and persistent storage state', () => {
    const patch = readFileSync(new URL('../profile.patch.yml', import.meta.url), 'utf8')
    expect(patch).not.toContain('tokens: []')
    expect(patch).toContain('0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0')
    expect(patch).toContain('pieceLedgerPath: /data/synapse/pieces.json')
    expect(patch).toContain('keyStorePath: /data/haven-aol/keys.json')
  })
})

describe('no-body-timeout preload', () => {
  it('uses one-hour undici timers and the wrapper marker', async () => {
    const preload = await import('../mausbot/no-body-timeout.cjs')
    expect(preload.ONE_HOUR_MS).toBe(3_600_000)
    expect(preload.MARKER).toBe('--require /opt/agent/no-body-timeout.cjs')
    // Importing without the marker must not install a global dispatcher.
    expect(typeof preload.install).toBe('function')
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
