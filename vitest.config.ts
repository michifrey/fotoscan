import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Nur die Modultests; die Browsertests unter e2e/ laufen über Playwright.
    include: ['tests/**/*.test.ts'],
  },
});
