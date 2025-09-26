import { build } from 'esbuild'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const outDir = path.join(__dirname, 'dist')
const outFile = path.join(outDir, 'server.bundle.cjs')

fs.mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [path.join(__dirname, 'server.js')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  logLevel: 'info',
  sourcemap: false,
})

console.log(`Bundled server to ${outFile}`)
