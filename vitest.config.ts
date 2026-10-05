import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/**/test/**/*.test.ts',
            'services/**/test/**/*.test.ts',
            'tests/unit/**/*.test.ts',
          ],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'packages/**/test/**/*.int.test.ts',
            'services/**/test/**/*.int.test.ts',
            'tests/integration/**/*.int.test.ts',
          ],
          globalSetup: ['tests/integration/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
