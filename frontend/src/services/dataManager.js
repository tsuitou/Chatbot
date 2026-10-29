import * as db from './db'

/** @typedef {import('./db').ArchiveScope} ArchiveScope */

/** @param {ArchiveScope} [scope] */
export async function exportArchive(scope = { kind: 'all' }) {
  return db.exportArchive(scope)
}

/** @param {ArchiveScope} [scope] */
export async function exportAllChats(scope = { kind: 'all' }) {
  return exportArchive(scope)
}

/**
 * @param {File | Blob} file
 * @param {{ idRewrite?: string, onProgress?: (progress: unknown) => void }} [options]
 */
export async function importFromArchive(
  file,
  { idRewrite = 'always', onProgress } = {}
) {
  return db.importArchive(file, { idMode: idRewrite, onProgress })
}

export async function getModelSettings() {
  return db.getModelSettings()
}

export async function deleteAllData() {
  await db.clearStore()
}
