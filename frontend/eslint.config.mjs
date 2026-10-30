import js from '@eslint/js'
import eslintPluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import eslintConfigPrettier from 'eslint-config-prettier'
import prettierRecommended from 'eslint-plugin-prettier/recommended'

export default [
  { ignores: ['dist', 'dist-pwa', 'coverage'] },
  js.configs.recommended,
  ...eslintPluginVue.configs['flat/recommended'],
  {
    languageOptions: {
      globals: globals.browser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      // Build-time constant injected by vite.config.js.
      globals: { __LOCAL_DEFAULTS__: 'readonly' },
    },
  },
  {
    files: ['vite.config.js', 'build/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  // Prettier 併用時は最後に
  eslintConfigPrettier,
  prettierRecommended,
]
