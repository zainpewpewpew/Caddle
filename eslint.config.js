import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/', 'coverage/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['frontend/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // innerHTML/outerHTML/insertAdjacentHTML dilarang: seluruh render lewat h() + textContent.
      'no-restricted-properties': ['error',
        { property: 'innerHTML', message: 'Gunakan h()/textContent (pencegahan XSS).' },
        { property: 'outerHTML', message: 'Gunakan h()/textContent (pencegahan XSS).' },
        { property: 'insertAdjacentHTML', message: 'Gunakan h()/textContent (pencegahan XSS).' }],
      'no-restricted-globals': ['error', { name: 'localStorage', message: 'Hanya boleh untuk preferensi UI, lewat window.localStorage dengan try/catch.' }],
    },
  },
  {
    files: ['tests/e2e/**/*.js', 'playwright.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
