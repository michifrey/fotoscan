import { expect, test } from '@playwright/test';

test('Kameraeinstellungen öffnen und schliessen', async ({ page }) => {
  const fehler: string[] = [];
  page.on('pageerror', (error) => fehler.push(error.message));

  await page.goto('/');
  await page.getByTestId('album-name').fill('Objektivwahl');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.videoWidth > 0);
  });

  await expect(page.getByTestId('camera-settings')).toHaveCount(0);
  await page.getByTestId('camera-settings-open').click();

  const sheet = page.getByTestId('camera-settings');
  await expect(sheet).toBeVisible();
  // Das künstliche Kamerabild meldet nur ein Gerät – die App sagt das ehrlich,
  // statt eine leere Auswahl zu zeigen.
  await expect(sheet.getByText(/nur eine Kamera/)).toBeVisible();
  await expect(sheet.getByText(/Bildpunkte/)).toBeVisible();

  await page.getByTestId('settings-close').click();
  await expect(sheet).toHaveCount(0);

  // Der Auslöser ist danach wieder bedienbar.
  await expect(page.getByTestId('shutter')).toBeEnabled();
  expect(fehler).toEqual([]);
});
