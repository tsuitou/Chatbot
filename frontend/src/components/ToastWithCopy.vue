<template>
  <div class="toast-with-copy">
    <span class="toast-message">{{ message }}</span>
    <button class="Vue-Toastification__close-button" @click="copyToClipboard">
      <FontAwesomeIcon :icon="copyIcon" />
    </button>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
const props = defineProps({
  message: {
    type: String,
    required: true,
  },
})

const copyIcon = ref('copy')

const copyToClipboard = async () => {
  try {
    await navigator.clipboard.writeText(props.message)
    copyIcon.value = 'check'
    setTimeout(() => {
      copyIcon.value = 'copy'
    }, 2000)
  } catch (err) {
    console.error('Failed to copy text: ', err)
    // Maybe show a small error message inside the toast?
  }
}
</script>

<style scoped>
.toast-with-copy {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  gap: 16px;
}

.toast-message {
  word-break: break-all;
  white-space: pre-wrap;
}

button.Vue-Toastification__close-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 24px;
  font-size: 14px;
}
</style>
