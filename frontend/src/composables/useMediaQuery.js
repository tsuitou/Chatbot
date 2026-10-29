import { ref, onMounted, onBeforeUnmount } from 'vue'

// Reactive window.matchMedia(query).matches.
export function useMediaQuery(query) {
  const matches = ref(
    typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
  )
  let media = null
  const update = (event) => {
    matches.value = event.matches
  }
  onMounted(() => {
    media = window.matchMedia?.(query)
    if (!media) return
    matches.value = media.matches
    media.addEventListener('change', update)
  })
  onBeforeUnmount(() => media?.removeEventListener('change', update))
  return matches
}
