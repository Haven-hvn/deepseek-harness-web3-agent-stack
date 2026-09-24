import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/chain.ts', 'src/tools.ts', 'src/wallet.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
})
