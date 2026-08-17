import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
})
