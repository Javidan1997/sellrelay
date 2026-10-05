import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**',
      '**/.react-router/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'infra/**',
      'tests/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      // Monetary values must never use floating point parsing.
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Use decimal strings / integer minor units.' },
      ],
    },
  },
  {
    files: ['scripts/**/*.ts', 'packages/persistence/src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['apps/shopify/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
);
