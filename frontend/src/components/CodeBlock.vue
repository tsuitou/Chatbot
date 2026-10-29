<template>
  <div
    ref="wrapperRef"
    class="code-block-wrapper"
    :class="{ 'special-lang': isSpecialLang }"
    :style="wrapperPaddingStyle"
  >
    <div
      ref="headerRef"
      class="code-header"
      :class="{ pinned: isPinned }"
      :style="headerStyle"
    >
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
import { ref, onMounted, computed, nextTick, onUnmounted } from 'vue'
import { highlightCode } from '../services/highlight'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import { isDarkThemeActive } from '../services/theme'
const props = defineProps({
  content: { type: String, required: true },
  lang: { type: String, default: 'plaintext' },
})

const renderElement = ref(null)
const copyText = ref('Copy')
const copyIcon = ref('copy')
const showSource = ref(true)
const wrapperRef = ref(null)
const headerRef = ref(null)
const isPinned = ref(false)
const headerWidth = ref(0)
const headerLeft = ref(0)
const headerHeight = ref(0)
const scrollTarget = ref(null)
let resizeObserver
const topOffset = ref(0)
const MIN_PIN_HEIGHT = 400

const isSpecialLang = computed(
  () => props.lang === 'mermaid' || props.lang === 'svg'
)
const canToggleView = computed(() => isSpecialLang.value)

const highlightedHtml = computed(() => highlightCode(props.content, props.lang))

onMounted(async () => {
  if (canToggleView.value) {
    if (!showSource.value) {
      await renderContent()
    }
  }
  nextTick(() => {
    updateHeaderMetrics()
    handleScroll()
    setupScrollTarget()
    setupResizeObserver()
  })
})

onUnmounted(() => {
  teardownScrollTarget()
  teardownResizeObserver()
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
      // Re-read the theme on every render so a switch since mount applies.
      mermaid.initialize({
        startOnLoad: false,
        theme: isDarkThemeActive() ? 'dark' : 'neutral',
      })
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

const updateHeaderMetrics = () => {
  const wrapper = wrapperRef.value
  const header = headerRef.value
  if (!wrapper || !header) return
  computeTopOffset()
  const rect = wrapper.getBoundingClientRect()
  headerWidth.value = rect.width
  headerLeft.value = rect.left
  headerHeight.value = header.offsetHeight
}

const handleScroll = () => {
  const wrapper = wrapperRef.value
  const header = headerRef.value
  if (!wrapper || !header) return
  computeTopOffset()
  const rect = wrapper.getBoundingClientRect()
  const isTallEnough = rect.height >= MIN_PIN_HEIGHT
  const shouldPin =
    isTallEnough &&
    rect.top < topOffset.value &&
    rect.bottom > topOffset.value + headerHeight.value
  isPinned.value = shouldPin
  if (shouldPin) {
    updateHeaderMetrics()
  }
}

const setupScrollTarget = () => {
  const wrapper = wrapperRef.value
  if (!wrapper) return
  const target = findScrollableParent(wrapper) || window
  scrollTarget.value = target
  target.addEventListener('scroll', handleScroll, { passive: true })
  window.addEventListener('scroll', handleScroll, { passive: true })
  window.addEventListener('resize', updateHeaderMetrics)
}

const teardownScrollTarget = () => {
  if (scrollTarget.value) {
    scrollTarget.value.removeEventListener('scroll', handleScroll)
  }
  window.removeEventListener('scroll', handleScroll)
  window.removeEventListener('resize', updateHeaderMetrics)
}

const setupResizeObserver = () => {
  if (!wrapperRef.value || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => {
    updateHeaderMetrics()
    handleScroll()
  })
  resizeObserver.observe(wrapperRef.value)
}

const teardownResizeObserver = () => {
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
}

const findScrollableParent = (el) => {
  const overflowRegex = /(auto|scroll|overlay)/
  let current = el?.parentElement || null
  while (current) {
    const style = getComputedStyle(current)
    if (
      overflowRegex.test(style.overflowY) ||
      overflowRegex.test(style.overflow)
    ) {
      return current
    }
    current = current.parentElement
  }
  return window
}

const computeTopOffset = () => {
  const chatHeader = document.querySelector('.chat-header')
  if (chatHeader) {
    const rect = chatHeader.getBoundingClientRect()
    topOffset.value = Math.max(0, rect.top + rect.height)
    return
  }
  topOffset.value = 0
}

const headerStyle = computed(() => {
  if (!isPinned.value) return {}
  return {
    position: 'fixed',
    top: `${topOffset.value}px`,
    left: `${headerLeft.value}px`,
    width: `${headerWidth.value}px`,
    zIndex: 5,
  }
})

const wrapperPaddingStyle = computed(() => {
  if (!isPinned.value) return {}
  return {
    paddingTop: `${headerHeight.value}px`,
  }
})
</script>
