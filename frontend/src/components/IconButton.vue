<template>
  <button type="button" :title="label" :aria-label="label">
    <slot />
  </button>
</template>

<script setup>
// A button whose only content is an icon. The label is required so every
// such button has an accessible name (and a tooltip).
defineProps({
  label: { type: String, required: true },
})
</script>
