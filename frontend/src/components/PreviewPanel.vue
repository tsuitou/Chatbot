<template>
  <aside v-if="isOpen" class="preview-panel">
    <div class="preview-header">
      <select
        v-model="activeFileId"
        class="file-select"
        title="Select a file to preview"
      >
        <option v-for="file in files" :key="file.id" :value="file.id">
          {{ file.name }}
        </option>
      </select>
      <div class="actions">
        <a
          :href="downloadUrl"
          :download="activeFile?.name"
          class="action-btn"
          title="Download file"
        >
          <font-awesome-icon icon="download" />
        </a>
        <button class="action-btn" title="Close preview" @click="closePanel">
          <font-awesome-icon icon="times" />
        </button>
      </div>
    </div>
    <div class="preview-content">
      <template v-if="activeFile">
        <img
          v-if="isImage"
          :src="contentUrl"
          class="preview-image"
          alt="File preview"
        />
        <pre v-else-if="isText" class="preview-text">{{ textContent }}</pre>
        <div v-else class="unsupported-view">
          <p>This file type cannot be previewed.</p>
        </div>
      </template>
      <div v-else class="no-file-view">
        <p>Select a file to preview.</p>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { computed, ref, watch, onUnmounted } from 'vue'
import { useDisplayStore } from '../stores/display'
const store = useDisplayStore()

const isOpen = computed(() => store.isPreviewOpen)
const files = computed(() => store.previewableFiles)
const activeFile = computed(() => store.activePreviewFile)

const textContent = ref('')
const objectUrl = ref(null)

const activeFileId = computed({
  get: () => store.activePreviewFileId,
  set: (id) => store.setActivePreviewFile(id),
})

const isImage = computed(() => activeFile.value?.mimeType.startsWith('image/'))
const isText = computed(() => activeFile.value?.mimeType.startsWith('text/'))

const cleanupObjectUrl = () => {
  if (objectUrl.value) {
    URL.revokeObjectURL(objectUrl.value)
    objectUrl.value = null
  }
}

watch(
  activeFile,
  async (newFile) => {
    cleanupObjectUrl()

    if (newFile?.blob) {
      objectUrl.value = URL.createObjectURL(newFile.blob)
    }

    if (newFile?.mimeType?.startsWith('text/') && newFile?.blob) {
      textContent.value = await newFile.blob.text()
    } else {
      textContent.value = ''
    }
  },
  { immediate: true }
)

const contentUrl = computed(() => objectUrl.value)

const downloadUrl = computed(() => objectUrl.value || '#')

const closePanel = () => {
  store.closePreview()
}

onUnmounted(() => {
  cleanupObjectUrl()
})
</script>

<style scoped>
.preview-panel {
  width: 350px;
  flex-shrink: 0;
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  background-color: var(--bg-color);
}
.preview-header {
  display: flex;
  align-items: center;
  padding: 8px;
  border-bottom: 1px solid var(--border-color);
  background-color: var(--bg-color);
  flex-shrink: 0;
}
.file-select {
  flex-grow: 1;
  min-width: 0;
  padding: 6px;
  border-radius: var(--border-radius);
  border: 1px solid var(--border-color);
  background-color: var(--bg-color);
  color: var(--text-color);
}
.actions {
  display: flex;
  gap: 8px;
  margin-left: 8px;
}
.action-btn {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-light);
  width: 32px;
  height: 32px;
  border-radius: var(--border-radius);
  cursor: pointer;
  display: flex;
  justify-content: center;
  align-items: center;
  transition: var(--transition);
}
.action-btn:hover {
  background-color: var(--bg-gray);
  color: var(--text-color);
}
.preview-content {
  flex-grow: 1;
  overflow: auto;
  padding: 16px;
}
.preview-image {
  max-width: 100%;
  height: auto;
  border-radius: var(--border-radius);
}
.preview-text {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: monospace;
  font-size: 13px;
  color: var(--text-color);
}
.no-file-view,
.unsupported-view {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  color: var(--text-light);
}
</style>
