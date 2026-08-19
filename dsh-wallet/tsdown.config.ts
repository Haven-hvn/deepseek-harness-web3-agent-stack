import { defineConfig } from 'tsdown'

/**
 * Self-contained build for the installable bundle (docs/user/develop/basic/
 * publish.md: a git/path install runs `prepare`, which must build the
 * published entry points from source without monorepo context). Transpiles
 * src/ to lib/ with declarations; no project references, no type-check pass.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/types.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
})
