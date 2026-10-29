import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  base: '/chatbot/',
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    restoreMocks: true,
    // The HTML exporter inlines processed CSS (?inline); test it as built.
    css: true,
  },
})
