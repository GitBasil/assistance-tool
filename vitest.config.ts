import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __CHUNKS__: '{}',
    __VERSION__: '"test"',
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'happy-dom',
  },
});
