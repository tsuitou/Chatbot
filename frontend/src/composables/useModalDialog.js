import { onMounted, onBeforeUnmount } from 'vue'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Modal dialog keyboard behaviour: focus moves into the dialog when it
// opens, Tab stays inside it, Escape closes it, and focus returns to where
// it was when the dialog closes.
export function useModalDialog(dialogRef, onClose) {
  let previouslyFocused = null

  const focusable = () =>
    [...(dialogRef.value?.querySelectorAll(FOCUSABLE) || [])].filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    )

  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const items = focusable()
    if (!items.length) {
      event.preventDefault()
      dialogRef.value?.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const inside = dialogRef.value?.contains(document.activeElement)
    if (event.shiftKey && (document.activeElement === first || !inside)) {
      event.preventDefault()
      last.focus()
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !inside)
    ) {
      event.preventDefault()
      first.focus()
    }
  }

  onMounted(() => {
    previouslyFocused = document.activeElement
    document.addEventListener('keydown', onKeydown, true)
    // The first field is more useful than the close button in the header.
    const items = focusable()
    const target = items.find((el) => !el.closest('.modal-header')) || items[0]
    ;(target || dialogRef.value)?.focus()
  })

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown, true)
    if (previouslyFocused?.isConnected) previouslyFocused.focus()
  })
}
