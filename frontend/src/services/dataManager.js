import * as db from './db'

export async function exportArchive(scope = { kind: 'all' }) {
  return db.exportArchive(scope)
}

export async function exportAllChats(scope = { kind: 'all' }) {
  return exportArchive(scope)
}

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
