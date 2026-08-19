import { defineConfig } from 'vitest/config'

/**
 * Workspace test runner. Tests live at package level under `<pkg>/tests/`
 * (dsh convention) and import their package sources by relative path, so no
 * alias table is needed; @deepseek-ai/* test dependencies resolve from
 * node_modules after `pnpm install`.
 */
export default defineConfig({
  test: {
    include: ['*/tests/**/*.spec.ts'],
    environment: 'node',
  },
})
