import { defineConfig } from 'vitest/config';

// Единый пакет: тесты лежат рядом с исходниками в `src/`, алиасы не нужны.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
