import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: ['src/index.ts', 'src/serve.ts', 'src/snapshot.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
})
