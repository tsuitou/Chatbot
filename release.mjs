#!/usr/bin/env node

import fs from 'fs/promises'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_BUILD_ENV_KEYS = ['VITE_MAX_UPLOAD_FILE_SIZE']
const BACKEND_RELEASE_EXCLUDES = [
  'node_modules',
  'dist',
  'key',
  'key_valid',
  'bundle.mjs',
  'build-sea.mjs',
  'sea-config.json',
  'uploads',
]

const git = (...args) =>
  execFileSync('git', args, { cwd: __dirname, encoding: 'utf8' }).trim()

// --publish releases what is on origin/main, so the zip never picks up
// uncommitted or unpushed changes.
function assertPublishable(tag) {
  if (git('branch', '--show-current') !== 'main') {
    throw new Error('Publish from the main branch.')
  }
  if (git('status', '--porcelain')) {
    throw new Error('The working tree has uncommitted changes.')
  }
  git('fetch', 'origin', 'main')
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
    throw new Error('main is not in sync with origin/main.')
  }
  if (git('tag', '--list', tag)) {
    throw new Error(`Tag ${tag} already exists.`)
  }
}

function publish(tag, zipPath) {
  git('tag', tag)
  git('push', 'origin', tag)
  execFileSync(
    'gh',
    [
      'release',
      'create',
      tag,
      zipPath,
      '--title',
      `Release ${tag}`,
      '--generate-notes',
      '--verify-tag',
    ],
    { cwd: __dirname, stdio: 'inherit' }
  )
  console.log(`Published ${tag}`)
}

async function main() {
  const args = process.argv.slice(2)
  const shouldPublish = args.includes('--publish')
  const version = args.find((arg) => !arg.startsWith('--'))
  if (!version) {
    console.error('Usage: node release.mjs <version> [--publish]')
    console.error('Example: node release.mjs 0.1.2')
    console.error('  --publish  also tag the release and create it on GitHub')
    process.exit(1)
  }
  if (!/^[0-9A-Za-z._-]+$/.test(version)) {
    console.error(
      'Version may only contain letters, numbers, dots, dashes, and underscores.'
    )
    process.exit(1)
  }

  console.log(`Creating release v${version}...`)

  try {
    if (shouldPublish) assertPublishable(`v${version}`)

    const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    const releaseName = `chatbot_v${version}`
    const zipName = `${releaseName}.zip`
    const releaseDir = path.join(__dirname, 'releases')
    const tempDir = path.join(releaseDir, releaseName)
    const frontendBuildEnv = await resolveFrontendBuildEnv()

    // 1. フロントエンドのビルド
    console.log('Building frontend...')
    for (const [key, value] of Object.entries(frontendBuildEnv)) {
      console.log(`Frontend build env: ${key}=${value}`)
    }
    execFileSync(pnpmCommand, ['run', 'build'], {
      cwd: path.join(__dirname, 'frontend'),
      stdio: 'inherit',
      env: {
        ...process.env,
        ...frontendBuildEnv,
      },
    })

    // 2. リリース用ディレクトリ作成
    await fs.mkdir(releaseDir, { recursive: true })
    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.rm(path.join(releaseDir, zipName), { force: true })
    await fs.mkdir(tempDir, { recursive: true })

    // 2.5 ルートファイルのコピー
    const rootFiles = ['README.md']
    for (const file of rootFiles) {
      await copyFile(path.join(__dirname, file), path.join(tempDir, file))
    }

    // 3. バックエンドファイルのコピー
    await copyBackendReleaseFiles(path.join(__dirname, 'backend'), tempDir)

    // 4. フロントエンドdistディレクトリのコピー
    await copyDir(
      path.join(__dirname, 'frontend', 'dist'),
      path.join(tempDir, 'dist')
    )

    // 5. keyファイルのひな型を作成
    await fs.writeFile(
      path.join(tempDir, 'key'),
      `${JSON.stringify({ gemini: '', claude: '', openrouter: '' }, null, 2)}\n`,
      'utf8'
    )
    console.log('Created key template')

    // 6. リリースメタデータの作成
    await fs.writeFile(
      path.join(tempDir, 'release-info.json'),
      JSON.stringify(
        {
          version,
          createdAt: new Date().toISOString(),
          frontendBuildEnv,
        },
        null,
        2
      )
    )
    console.log('Created release-info.json')

    // 7. package.jsonのバージョン更新
    const packageJsonPath = path.join(tempDir, 'package.json')
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'))
    packageJson.version = version
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2))

    // 8. zipファイルの作成
    console.log(`Creating ${zipName}...`)
    execFileSync('zip', ['-r', zipName, releaseName], {
      cwd: releaseDir,
      stdio: 'inherit',
    })

    // 9. 一時ディレクトリの削除
    await fs.rm(tempDir, { recursive: true })

    console.log(`Release ${zipName} created successfully!`)
    console.log(`Location: ${path.join(releaseDir, zipName)}`)

    if (shouldPublish) publish(`v${version}`, path.join(releaseDir, zipName))
  } catch (error) {
    console.error('Release failed:', error.message)
    process.exit(1)
  }
}

async function resolveFrontendBuildEnv() {
  const frontendDir = path.join(__dirname, 'frontend')
  const fileEnv = {
    ...(await readEnvFile(path.join(frontendDir, '.env'))),
    ...(await readEnvFile(path.join(frontendDir, '.env.production'))),
  }
  const resolved = {}

  for (const key of FRONTEND_BUILD_ENV_KEYS) {
    const value = process.env[key] || fileEnv[key]
    if (!value) {
      throw new Error(
        `Missing required frontend build environment value: ${key}`
      )
    }
    resolved[key] = value
  }

  return resolved
}

async function readEnvFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    const result = {}
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const separator = trimmed.indexOf('=')
      if (separator === -1) continue
      const key = trimmed.slice(0, separator).trim()
      const value = trimmed.slice(separator + 1).trim()
      if (!key) continue
      result[key] = value
    }
    return result
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

async function copyBackendReleaseFiles(src, dest) {
  await copyDir(src, dest, {
    shouldExclude(relativePath) {
      const parts = relativePath.split(path.sep)
      return parts.some((part) => BACKEND_RELEASE_EXCLUDES.includes(part))
    },
  })
}

async function copyFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.copyFile(src, dest)
  console.log(`Copied: ${path.basename(src)}`)
}

async function copyDir(src, dest, options = {}) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    const relativePath = path.relative(dest, destPath)
    if (options.shouldExclude?.(relativePath)) {
      continue
    }

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, options)
    } else {
      await fs.copyFile(srcPath, destPath)
    }
  }
  console.log(`Copied directory: ${path.basename(src)}`)
}

main()
