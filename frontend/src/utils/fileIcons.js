export const getFileTypeIcon = (mimeType) => {
  const type = typeof mimeType === 'string' ? mimeType.toLowerCase() : ''
  if (type.startsWith('image/')) return 'file-image'
  if (type.startsWith('video/')) return 'file-video'
  if (type.startsWith('audio/')) return 'file-audio'
  if (type === 'application/pdf') return 'file-pdf'
  if (type.includes('spreadsheet') || type.includes('excel'))
    return 'file-excel'
  if (type.includes('word')) return 'file-word'
  if (type.includes('presentation') || type.includes('powerpoint'))
    return 'file-powerpoint'
  if (type.includes('archive') || type.includes('zip')) return 'file-archive'
  if (type === 'text/csv') return 'file-csv'
  if (type.startsWith('text/')) return 'file-code'
  return 'file'
}
