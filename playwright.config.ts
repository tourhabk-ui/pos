import { defineConfig, devices } from '@playwright/test';

// Когда BASE_URL указывает на внешний адрес (прод/стейдж) — свой dev-сервер не
// поднимаем, гоняем спеки против уже живого приложения (прод-smoke без БД).
// Без BASE_URL или на localhost — как раньше: playwright сам стартует `npm run dev`.
const baseURL = process.env.BASE_URL || 'http://localhost:3000';
const isRemoteTarget = !!process.env.BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.BASE_URL);

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    // Mobile
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },
  ],

  webServer: isRemoteTarget
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
      },
});
