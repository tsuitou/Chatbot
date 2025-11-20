#!/usr/bin/env node

import fs from 'fs/promises'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function main() {
  const version = process.argv[2]
  if (!version) {
    console.error('Usage: node release.mjs <version>')
    console.error('Example: node release.mjs 0.1.2')
    process.exit(1)
  }

  console.log(`Creating release v${version}...`)

  try {
    // 1. フロントエンドのビルド
    console.log('Building frontend...')
    execSync('npm run build', {
      cwd: path.join(__dirname, 'frontend'),
      stdio: 'inherit'
    })

    // 2. リリース用ディレクトリ作成
    const releaseDir = path.join(__dirname, 'releases')
    const tempDir = path.join(releaseDir, `chatbot_v${version}`)
    await fs.mkdir(releaseDir, { recursive: true })
    await fs.mkdir(tempDir, { recursive: true })

    // 3. バックエンドファイルのコピー
    const backendFiles = [
      'server.js',
      'package.json',
      'package-lock.json',
      '.env',
      'system_instruction.txt',
      'launch.bat',
      'launch.sh',
    ]

    for (const file of backendFiles) {
      await copyFile(
        path.join(__dirname, 'backend', file),
        path.join(tempDir, file)
      )
    }

    // 3.5 バックエンドディレクトリのコピー (追加部分)
    const backendDirs = [
      'capabilities',
      'providers'
    ]

    for (const dir of backendDirs) {
      // 存在チェックを行ってからコピー（任意の場合はtry-catchで囲むなど調整可）
      const srcPath = path.join(__dirname, 'backend', dir)
      const destPath = path.join(tempDir, dir)
      
      // ディレクトリが存在するか確認してからコピー実行
      try {
          await fs.access(srcPath)
          await copyDir(srcPath, destPath)
      } catch (error) {
          console.warn(`Warning: Directory not found, skipping: ${srcPath}`)
      }
    }

    // 4. フロントエンドdistディレクトリのコピー
    await copyDir(
      path.join(__dirname, 'frontend', 'dist'),
      path.join(tempDir, 'dist')
    )

    // 5. 空のkeyファイルを作成
    await fs.writeFile(path.join(tempDir, 'key'), '', 'utf8')
    console.log('Created empty key file')

    // 6. package.jsonのバージョン更新
    const packageJsonPath = path.join(tempDir, 'package.json')
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'))
    packageJson.version = version
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2))

    // 7. zipファイルの作成
    const zipName = `chatbot_v${version}.zip`
    console.log(`Creating ${zipName}...`)
    execSync(`cd "${releaseDir}" && zip -r "${zipName}" "chatbot_v${version}"`, {
      stdio: 'inherit'
    })

    // 8. 一時ディレクトリの削除
    await fs.rm(tempDir, { recursive: true })

    console.log(`Release ${zipName} created successfully!`)
    console.log(`Location: ${path.join(releaseDir, zipName)}`)

  } catch (error) {
    console.error('Release failed:', error.message)
    process.exit(1)
  }
}

async function copyFile(src, dest) {
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(src, dest)
    console.log(`Copied: ${path.basename(src)}`)
  } catch (error) {
    console.warn(`Warning: Could not copy ${src}: ${error.message}`)
  }
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else {
      await fs.copyFile(srcPath, destPath)
    }
  }
  console.log(`Copied directory: ${path.basename(src)}`)
}

main()