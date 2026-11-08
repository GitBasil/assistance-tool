import { defineConfig } from '@playwright/test';

const PORT = +(process.env.COMPAT_PORT || 7900);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.PW_CHANNEL || 'msedge',
    viewport: { width: 1280, height: 800 },
    // Real-user fingerprint so sessions aren't treated as bots (bots aren't recorded).
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    launchOptions: { args: ['--disable-blink-features=AutomationControlled'] },
  },
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: `http://localhost:${PORT}/__events`,
    reuseExistingServer: !process.env.CI,
    env: { COMPAT_PORT: String(PORT) },
  },
});
