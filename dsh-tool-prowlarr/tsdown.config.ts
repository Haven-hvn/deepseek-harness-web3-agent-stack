import { defineConfig } from 'tsdown'

/**
 * Self-contained build for the installable bundle: a git/path install runs
 * `prepare`, which must build the published entry points from source.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts', 'src/types.ts', 'src/links.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
})
