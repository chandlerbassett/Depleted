import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.ts', '**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue']
      }
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Variables declared in <script setup> are used by the template compiler —
      // ESLint 9 does not understand this, so we disable the rule for Vue files.
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'vue/component-api-style': ['error', ['script-setup']],
      'vue/define-macros-order': ['error', { order: ['defineProps', 'defineEmits'] }]
    }
  },
  {
    // electron-builder hooks run as CommonJS in Node
    files: ['build/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly', console: 'readonly' }
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  },
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**']
  }
]
