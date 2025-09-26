<template>
  <div class="code-block-wrapper" :class="{ 'special-lang': isSpecialLang }">
    <div class="code-header">
      <span class="language-name">{{ lang }}</span>
      <div class="actions">
        <button v-if="canToggleView" class="action-btn" @click="toggleView">
          <font-awesome-icon :icon="showSource ? 'eye' : 'code'" />
          <span>{{ showSource ? 'View' : 'Source' }}</span>
        </button>
        <button class="action-btn" @click="copyToClipboard">
          <font-awesome-icon :icon="copyIcon" />
          <span>{{ copyText }}</span>
        </button>
      </div>
    </div>
    <div class="code-content">
      <!-- Source Code View -->
      <pre v-show="showSource"><code v-html="highlightedHtml"></code></pre>
      <!-- Rendered View (for Mermaid/SVG) -->
      <div
        v-if="canToggleView && !showSource"
        ref="renderElement"
        class="render-view"
      ></div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, nextTick } from 'vue'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
const props = defineProps({
  content: { type: String, required: true },
  lang: { type: String, default: 'plaintext' },
})

const renderElement = ref(null)
const copyText = ref('Copy')
const copyIcon = ref('copy')
const showSource = ref(true)

const isSpecialLang = computed(
  () => props.lang === 'mermaid' || props.lang === 'svg'
)
const canToggleView = computed(() => isSpecialLang.value)

const highlightedHtml = computed(() => {
  const raw = props.content ?? ''
  const lang = (props.lang || '').toLowerCase()

  if (lang === 'mermaid') {
    return DOMPurify.sanitize(
      hljs.highlight(raw, { language: 'plaintext' }).value
    )
  }
  if (lang === 'svg') {
    return DOMPurify.sanitize(hljs.highlight(raw, { language: 'svg' }).value)
  }

  try {
    if (lang && hljs.getLanguage(lang)) {
      return DOMPurify.sanitize(hljs.highlight(raw, { language: lang }).value)
    }
    const auto = hljs.highlightAuto(raw)
    return DOMPurify.sanitize(auto.value)
  } catch {
    return DOMPurify.sanitize(
      hljs.highlight(raw, { language: 'plaintext' }).value
    )
  }
})

onMounted(async () => {
  if (canToggleView.value) {
    mermaid.initialize({ startOnLoad: false, theme: 'neutral' })
    if (!showSource.value) {
      await renderContent()
    }
  }
})

const copyToClipboard = async () => {
  try {
    await navigator.clipboard.writeText(props.content)
    copyText.value = 'Copied!'
    copyIcon.value = 'check'
    setTimeout(() => {
      copyText.value = 'Copy'
      copyIcon.value = 'copy'
    }, 2000)
  } catch (err) {
    console.error('Failed to copy text: ', err)
    setTimeout(() => {
      copyText.value = 'Error'
    }, 2000)
  }
}

const toggleView = () => {
  showSource.value = !showSource.value
  if (!showSource.value) {
    nextTick(() => {
      renderContent()
    })
  }
}

const renderContent = async () => {
  if (!renderElement.value) return

  if (props.lang === 'mermaid') {
    try {
      const uniqueId = `mermaid-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
      const { svg } = await mermaid.render(
        uniqueId,
        props.content,
        renderElement.value
      )
      renderElement.value.innerHTML = svg
    } catch (e) {
      renderElement.value.innerHTML = 'Error rendering Mermaid diagram.'
      console.error(e)
    }
  } else if (props.lang === 'svg') {
    renderElement.value.innerHTML = DOMPurify.sanitize(props.content, {
      USE_PROFILES: { svg: true },
    })
  }
}
</script>

<style scoped>
.code-block-wrapper {
  border-radius: var(--border-radius);
  border: 1px solid var(--border-color);
  background-color: var(--bg-light);
  margin: 8px 0;
  white-space: pre;
  overflow: auto;
  width: auto;
}
.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background-color: var(--text-light);
  padding: 4px 12px;
  color: #ccc;
  font-size: 12px;
}
.language-name {
  font-family: monospace;
  color: var(--bg-gray);
}
.actions {
  display: flex;
  gap: 8px;
}
.action-btn {
  background: none;
  border: 1px solid var(--bg-gray);
  color: var(--bg-gray);
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  transition: var(--transition);
}
.action-btn:hover {
  background-color: var(--text-color);
  color: var(--bg-color);
}
.code-content {
  background-color: var(--bg-light);
  padding: 12px;
}
.render-view {
  background-color: var(--bg-light);
  padding: 16px;
  border-radius: 4px;
}
pre,
code {
  margin: 0;
  padding: 0;
  background: none;
  font-family: 'Courier New', Courier, monospace;
  font-size: 14px;
}
</style>
