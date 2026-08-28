import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const PORT = 4177;

// In vorbereiteten Umgebungen liegt Chromium bereits an einer festen Stelle.
// Lokal übernimmt Playwright wie gewohnt seinen eigenen Download.
const PRESET_CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const executablePath = existsSync(PRESET_CHROMIUM) ? PRESET_CHROMIUM : undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Pixel 7'],
    launchOptions: { executablePath },
  },
  projects: [
    {
      // Der Kamerazugriff wird bewusst nicht erlaubt: Dieser Test geht den Weg
      // über „Galerie" und prüft damit zugleich das Verhalten ohne Kamera.
      name: 'ohne-kamera',
      testMatch: /scan\.spec\.ts/,
      use: { permissions: [] },
    },
    {
      // Chromium liefert ein künstliches Kamerabild; die Neigung des Telefons
      // wird im Test als DeviceOrientation-Ereignis nachgestellt.
      name: 'mit-kamera',
      testMatch: /(entspiegeln|kamera)\.spec\.ts/,
      use: {
        permissions: ['camera'],
        launchOptions: {
          executablePath,
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
