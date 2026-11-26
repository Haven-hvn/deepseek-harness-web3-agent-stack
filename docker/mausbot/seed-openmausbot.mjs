#!/usr/bin/env node
/**
 * seed-openmausbot.mjs — First-boot seeding for `/data/openmausbot/config.json`
 * and safe POSIX-shell serialization for `/data/keys/model.env`.
 *
 * Pre-wires OpenMausBot's built-in `deepseek` engine (`deepseekAgent` driver)
 * to `/opt/agent/dsh-acp-wrapper.sh` (the containerized Haven web3 ACP profile)
 * and sets it as the default model selection for new bots, while preserving the
 * rest of OpenMausBot's provider fleet via `PRODUCT_FLEET_ADDITIONS`.
 *
 * Secrets (API keys, EVM keys, Prowlarr keys) are NEVER written to config.json.
 * Existing config files are left untouched so user edits in Settings persist.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DSH_WRAPPER = '/opt/agent/dsh-acp-wrapper.sh';
export const DEFAULT_DSH_HOME = '/data/dsh';

const MODEL_ENV_KEYS = [
  'MODEL_BASE_URL',
  'MODEL_ID',
  'MODEL_API_KEY',
  'MODEL_API_PROTOCOL',
  // Optional size/reasoning knobs consumed by profile.acp.patch.yml's `spark`
  // provider. Persisted here so they survive container recreation alongside
  // the rest of the MODEL_* set.
  'MODEL_CONTEXT_WINDOW',
  'MODEL_MAX_OUTPUT_TOKENS',
  'MODEL_REASONING_EFFORT',
  'DEEPSEEK_API_KEY',
];

/**
 * POSIX-safe single-quoted shell literal (escapes embedded single quotes as `'\''`).
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Serialize non-empty model-related environment variables as POSIX shell
 * assignments suitable for sourcing from `dsh-acp-wrapper.sh`.
 */
export function formatModelEnv(env = process.env) {
  const lines = [];
  for (const key of MODEL_ENV_KEYS) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.length > 0) {
      lines.push(`${key}=${shellQuote(raw)}`);
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * Write `/data/keys/model.env` (0600) if any model env vars are present.
 */
export function writeModelEnv(filePath, env = process.env) {
  const body = formatModelEnv(env);
  if (!body) return false;
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, body, { mode: 0o600 });
  try { chmodSync(filePath, 0o600); } catch { /* best effort */ }
  return true;
}

/**
 * Derive the initial `<provider>/<model>` picker id matching `profile.acp.patch.yml`.
 */
export function resolveDefaultModelId(env = process.env) {
  const baseUrl = String(env.MODEL_BASE_URL ?? '').trim();
  const modelId = String(env.MODEL_ID ?? '').trim();
  if (baseUrl) {
    return `spark/${modelId || 'default'}`;
  }
  return `deepseek-official/${modelId || 'deepseek-v4-flash'}`;
}

/**
 * Build an OpenMausBot `config.json` document conforming to `appConfigSchema`.
 * Includes `claude`, `codex`, and `grok` alongside `deepseek` so OpenMausBot's
 * `instanceConfigs()` keeps `PRODUCT_FLEET_ADDITIONS` (OpenAI, OpenRouter,
 * Claude API, etc.) available in Settings → AI → Providers.
 */
export function buildInitialOpenMausBotConfig(env = process.env) {
  const defaultModel = resolveDefaultModelId(env);
  const serverName = String(env.OMB_SERVER_NAME ?? '').trim() || 'Haven Web3 Agent';
  const dshHome = String(env.DSH_HOME ?? '').trim() || DEFAULT_DSH_HOME;
  const cli = String(env.HAVEN_DSH_WRAPPER ?? '').trim() || DEFAULT_DSH_WRAPPER;

  const selection = {
    instanceId: 'deepseek',
    model: defaultModel,
  };

  return {
    computerName: serverName.slice(0, 63),
    defaultModelSelection: selection,
    newBotDefaults: {
      profile: {
        modelSelection: selection,
      },
    },
    // One-hour room turn timeout: matches OMB_TURN_STALL_MS /
    // OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS and the `spark` provider timeouts
    // so a slow JIT-loaded local model is never cut off mid-turn.
    rooms: { turnTimeoutMinutes: 60 },
    instances: {
      deepseek: {
        driver: 'deepseekAgent',
        displayName: 'Haven Web3 (dsh)',
        icon: { kind: 'preset', preset: 'deepseek' },
        config: { cli },
        environment: {
          DSH_HOME: dshHome,
        },
      },
      claude: { driver: 'claudeAgent' },
      codex: { driver: 'codex' },
      grok: { driver: 'grokAgent' },
    },
  };
}

/**
 * Seed `<dataDir>/config.json` if it does not already exist.
 * Returns `{ created: boolean, path: string, defaultModel: string }`.
 */
export function seedOpenMausBotConfig(dataDir, env = process.env) {
  const configPath = join(dataDir, 'config.json');
  const defaultModel = resolveDefaultModelId(env);
  if (existsSync(configPath)) {
    return { created: false, path: configPath, defaultModel };
  }
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const doc = buildInitialOpenMausBotConfig(env);
  writeFileSync(configPath, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(configPath, 0o600); } catch { /* best effort */ }
  return { created: true, path: configPath, defaultModel };
}

const invokedAsMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  const mode = process.argv[2];
  if (mode === '--write-model-env') {
    const target = process.argv[3] || '/data/keys/model.env';
    writeModelEnv(target, process.env);
  } else {
    const dataDir = mode || process.env.OMB_DATA_DIR || '/data/openmausbot';
    const res = seedOpenMausBotConfig(dataDir, process.env);
    console.log(JSON.stringify(res));
  }
}
