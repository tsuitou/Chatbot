import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: 'inherit',
    cwd: __dirname,
    ...options,
  })
}

async function main() {
  const windowsNodePath =
    process.env.WINDOWS_NODE_PATH || '/mnt/c/Program Files/nodejs/node.exe'

  if (!fs.existsSync(windowsNodePath)) {
    throw new Error(
      `Windows node executable not found. Set WINDOWS_NODE_PATH (current: ${windowsNodePath}).`
    )
  }

  // 1. Bundle sources
  run(process.execPath, [path.join(__dirname, 'bundle.mjs')])

  // 2. Produce SEA payload
  run(process.execPath, [
    '--experimental-sea-config',
    path.join(__dirname, 'sea-config.json'),
  ])

  // 3. Prepare executable template
  const exeTarget = path.join(__dirname, 'chatbot.exe')
  try {
    if (fs.existsSync(exeTarget)) {
      fs.unlinkSync(exeTarget)
    }
  } catch (error) {
    console.warn('Warning: failed to remove previous chatbot.exe', error)
  }

  fs.copyFileSync(windowsNodePath, exeTarget)
  fs.chmodSync(exeTarget, 0o755)

  // 4. Inject SEA blob
  const postjectPath = path.join(__dirname, 'node_modules', '.bin', 'postject')
  if (!fs.existsSync(postjectPath)) {
    throw new Error('postject binary not found. Run npm install first.')
  }

  const seaBlob = path.join(__dirname, 'server.sea')
  const sentinel = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

  run(postjectPath, [
    exeTarget,
    'NODE_SEA_BLOB',
    seaBlob,
    '--sentinel-fuse',
    sentinel,
  ])

  console.log('SEA build complete: chatbot.exe is ready.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
