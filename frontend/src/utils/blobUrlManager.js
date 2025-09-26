export class BlobUrlManager {
  constructor() {
    this.urls = new Map()
  }

  create(id, blob) {
    if (!id || !blob) return null

    this.revoke(id)

    try {
      const url = URL.createObjectURL(blob)
      this.urls.set(id, url)
      return url
    } catch (error) {
      console.error('Failed to create blob URL:', error)
      return null
    }
  }

  revoke(id) {
    if (!id) return

    const url = this.urls.get(id)
    if (url) {
      try {
        URL.revokeObjectURL(url)
      } catch (error) {
        console.error('Failed to revoke blob URL:', error)
      } finally {
        this.urls.delete(id)
      }
    }
  }

  get(id) {
    if (!id) return null
    return this.urls.get(id) || null
  }

  has(id) {
    return id ? this.urls.has(id) : false
  }

  cleanup(keepIds) {
    const idsToRevoke = []

    for (const [id] of this.urls) {
      if (!keepIds.has(id)) {
        idsToRevoke.push(id)
      }
    }

    idsToRevoke.forEach((id) => this.revoke(id))
  }

  clear() {
    const allIds = Array.from(this.urls.keys())
    allIds.forEach((id) => this.revoke(id))
  }

  size() {
    return this.urls.size
  }
}

export const globalBlobUrlManager = new BlobUrlManager()
