import fs from 'fs'
import path from 'path'

export function makeResolveFirstExisting(baseDirs) {
  return function resolveFirstExisting(relativePath, type = 'file') {
    for (const dir of baseDirs) {
      const candidate = path.resolve(dir, relativePath)
      try {
        const stat = fs.statSync(candidate)
        if (type === 'dir' ? stat.isDirectory() : stat.isFile()) return candidate
      } catch {}
    }
    return null
  }
}
