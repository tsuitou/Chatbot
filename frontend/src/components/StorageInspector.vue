<template>
  <div class="storage-inspector">
    <!-- Storage Usage -->
    <div class="section">
      <h3>Storage Usage</h3>
      <p v-if="storageEstimate.usage !== null">
        Approximately
        <strong>{{ formatBytes(storageEstimate.usage) }}</strong> of
        <strong>{{ formatBytes(storageEstimate.quota) }}</strong> used.
      </p>
      <p v-else>Could not estimate storage usage.</p>
    </div>

    <!-- LocalStorage -->
    <div class="section">
      <div class="section-header">
        <h3>LocalStorage ({{ localStorageItems.length }} items)</h3>
        <button class="danger-btn" @click="clearLocalStorage">Clear All</button>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in localStorageItems" :key="item.key">
            <td>{{ item.key }}</td>
            <td>
              <pre>{{ item.value }}</pre>
            </td>
            <td>
              <button
                class="danger-btn-sm"
                @click="deleteLocalStorageItem(item.key)"
              >
                Delete
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- IndexedDB -->
    <div class="section">
      <div class="section-header">
        <h3>
          IndexedDB
          <span v-if="indexedDbTotal" class="records-summary">
            (showing
            {{ indexedDbRecords.length ? currentPageStart : 0 }}-
            {{ indexedDbRecords.length ? currentPageEnd : 0 }} of
            {{ indexedDbTotal }})
          </span>
        </h3>
        <button class="danger-btn" @click="clearIndexedDb">Clear All</button>
      </div>
      <div class="filter-controls">
        <label for="storage-filter">Filter by type:</label>
        <select id="storage-filter" v-model="dbFilter">
          <option
            v-for="option in filterOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }} ({{ option.count }})
          </option>
        </select>
      </div>
      <div v-if="isLoadingDbRecords" class="loading-state">
        Loading records...
      </div>
      <div v-else-if="!indexedDbRecords.length" class="empty-state">
        No records found for the selected filter.
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Type</th>
            <th>Details</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in indexedDbRecords" :key="record.id">
            <td class="record-id">{{ record.id }}</td>
            <td>{{ record.type }}</td>
            <td>
              <pre>{{ getRecordDetails(record) }}</pre>
            </td>
            <td>
              <button class="danger-btn-sm" @click="deleteDbRecord(record.id)">
                Delete
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="indexedDbTotal > pageSize" class="pagination">
        <button
          class="pagination-btn"
          :disabled="currentPage === 1 || isLoadingDbRecords"
          @click="goToPreviousPage"
        >
          Previous
        </button>
        <span class="pagination-info">
          Page {{ currentPage }} of {{ totalPages }} ({{ pageSize }} per page)
        </span>
        <button
          class="pagination-btn"
          :disabled="currentPage === totalPages || isLoadingDbRecords"
          @click="goToNextPage"
        >
          Next
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import * as db from '../services/db'

const PAGE_SIZE = 50

const storageEstimate = ref({ usage: null, quota: null })
const localStorageItems = ref([])
const dbFilter = ref('all')
const currentPage = ref(1)
const indexedDbRecords = ref([])
const indexedDbTotal = ref(0)
const recordCounts = ref({ all: 0, chat: 0, message: 0, attachment: 0 })
const isLoadingDbRecords = ref(false)
const pageSize = PAGE_SIZE

const filterOptions = computed(() => [
  { value: 'all', label: 'All', count: recordCounts.value.all },
  { value: 'chat', label: 'Chat', count: recordCounts.value.chat },
  { value: 'message', label: 'Message', count: recordCounts.value.message },
  {
    value: 'attachment',
    label: 'Attachment',
    count: recordCounts.value.attachment,
  },
])

const totalPages = computed(() => {
  if (!indexedDbTotal.value) return 1
  return Math.max(1, Math.ceil(indexedDbTotal.value / PAGE_SIZE))
})

const currentPageStart = computed(() => {
  if (!indexedDbTotal.value) return 0
  return (currentPage.value - 1) * PAGE_SIZE + 1
})

const currentPageEnd = computed(() => {
  if (!indexedDbTotal.value) return 0
  return Math.min(currentPage.value * PAGE_SIZE, indexedDbTotal.value)
})

onMounted(async () => {
  const estimate = await getStorageEstimate()
  storageEstimate.value = { usage: estimate.usage, quota: estimate.quota }
  loadLocalStorage()
  await refreshRecordCounts()
  await loadIndexedDbPage()
})

const loadLocalStorage = () => {
  localStorageItems.value = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    try {
      const value = JSON.parse(localStorage.getItem(key))
      localStorageItems.value.push({
        key,
        value: JSON.stringify(value, null, 2),
      })
    } catch {
      localStorageItems.value.push({ key, value: localStorage.getItem(key) })
    }
  }
}

const getCountForFilter = (counts, filter) => {
  if (filter === 'all') return counts.all
  if (filter === 'chat') return counts.chat
  if (filter === 'message') return counts.message
  if (filter === 'attachment') return counts.attachment
  return 0
}

const refreshRecordCounts = async () => {
  try {
    const counts = await db.getRecordCounts()
    recordCounts.value = counts
  } catch (error) {
    console.error('Failed to load record counts:', error)
    recordCounts.value = { all: 0, chat: 0, message: 0, attachment: 0 }
  }
}

const loadIndexedDbPage = async () => {
  isLoadingDbRecords.value = true
  try {
    const offset = (currentPage.value - 1) * PAGE_SIZE
    const { records, total } = await db.getRecordsPage({
      type: dbFilter.value,
      offset,
      limit: PAGE_SIZE,
    })
    indexedDbRecords.value = records
    indexedDbTotal.value = total
  } catch (error) {
    console.error('Failed to load IndexedDB records:', error)
    indexedDbRecords.value = []
    indexedDbTotal.value = 0
  } finally {
    isLoadingDbRecords.value = false
  }
}

watch(dbFilter, async () => {
  currentPage.value = 1
  await loadIndexedDbPage()
})

watch(currentPage, async (next, prev) => {
  if (next !== prev) {
    await loadIndexedDbPage()
  }
})

const getRecordDetails = (record) => {
  const details = { ...record }
  delete details.id
  delete details.type
  return JSON.stringify(details, null, 2)
}

const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

async function getStorageEstimate() {
  if (!('storage' in navigator && 'estimate' in navigator.storage)) {
    return {
      usage: null,
      quota: null,
    }
  }
  const estimate = await navigator.storage.estimate()
  return {
    usage: estimate.usage,
    quota: estimate.quota,
  }
}

// --- Actions ---

const clearLocalStorage = () => {
  if (confirm('Are you sure you want to delete all LocalStorage data?')) {
    localStorage.clear()
    loadLocalStorage()
  }
}

const deleteLocalStorageItem = (key) => {
  localStorage.removeItem(key)
  loadLocalStorage()
}

const clearIndexedDb = async () => {
  if (!confirm('Are you sure you want to delete all IndexedDB data?')) {
    return
  }
  await db.clearStore()
  await refreshRecordCounts()
  currentPage.value = 1
  await loadIndexedDbPage()
}

const deleteDbRecord = async (id) => {
  await db.deleteRecordById(id)
  await refreshRecordCounts()
  const totalForFilter = getCountForFilter(recordCounts.value, dbFilter.value)
  const maxPage = Math.max(1, Math.ceil(totalForFilter / PAGE_SIZE))
  if (currentPage.value > maxPage) {
    currentPage.value = maxPage
  }
  await loadIndexedDbPage()
}

const goToPreviousPage = () => {
  if (currentPage.value > 1 && !isLoadingDbRecords.value) {
    currentPage.value -= 1
  }
}

const goToNextPage = () => {
  if (currentPage.value < totalPages.value && !isLoadingDbRecords.value) {
    currentPage.value += 1
  }
}
</script>

<style scoped>
.storage-inspector {
  padding: 24px;
  font-size: 14px;
  color: var(--text-color);
}
.section {
  margin-bottom: 24px;
}
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-color);
}

.records-summary {
  font-size: 12px;
  color: var(--text-light);
  margin-left: 8px;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.data-table th,
.data-table td {
  border: 1px solid var(--border-color);
  padding: 8px;
  text-align: left;
  vertical-align: top;
}
.data-table th {
  background-color: var(--bg-light);
}
.record-id {
  max-width: 100px;
  word-break: break-all;
  font-size: 12px;
}
pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
  color: var(--text-color);
}
.filter-controls {
  margin-bottom: 12px;
}
.filter-controls label {
  margin-right: 8px;
}
.filter-controls select {
  padding: 6px;
  border-radius: var(--border-radius);
  border: 1px solid var(--border-color);
}

.loading-state,
.empty-state {
  padding: 16px;
  text-align: center;
  color: var(--text-light);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  background-color: var(--bg-light);
}
.danger-btn {
  background-color: var(--danger-color);
  color: white;
  border: none;
  padding: 6px 12px;
  border-radius: var(--border-radius);
  cursor: pointer;
  transition: var(--transition);
}
.danger-btn:hover {
  background-color: var(--danger-dark);
}
.danger-btn-sm {
  background-color: var(--danger-color);
  color: white;
  border: none;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: var(--transition);
}
.danger-btn-sm:hover {
  background-color: var(--danger-dark);
}

.pagination {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.pagination-btn {
  padding: 6px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  background-color: var(--bg-color);
  cursor: pointer;
  color: var(--text-color);
  transition: var(--transition);
}

.pagination-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.pagination-info {
  color: var(--text-light);
  font-size: 14px;
}
</style>
