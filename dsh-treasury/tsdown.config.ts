import { defineConfig } from 'tsdown'

/**
 * Self-contained build for the installable bundle (docs/user/develop/basic/
 * publish.md: a git/path install runs `prepare`, which must build the
 * published entry points from source without monorepo context).
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/policy.ts', 'src/types.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
})
