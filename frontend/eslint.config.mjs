import js from '@eslint/js'
import eslintPluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import eslintConfigPrettier from 'eslint-config-prettier'
import prettierRecommended from 'eslint-plugin-prettier/recommended'

export default [
  { ignores: ['dist', 'coverage'] },
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
  // Prettier 併用時は最後に
  eslintConfigPrettier,
  prettierRecommended,
]
