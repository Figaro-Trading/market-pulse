import js from '@eslint/js';
import globals from 'globals';

// Flat config (ESLint 9+). Two glob blocks: server-side files get Node
// globals, public/ files get browser globals.
export default [
  js.configs.recommended,
  {
    ignores: ['node_modules/', 'coverage/', 'dist/'],
  },
  {
    files: ['server.js', 'src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'eqeqeq': ['error', 'smart'],
      'prefer-const': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-var': 'error',
      'no-throw-literal': 'error',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'eqeqeq': ['error', 'smart'],
      'prefer-const': 'warn',
      'no-var': 'error',
    },
  },
];
