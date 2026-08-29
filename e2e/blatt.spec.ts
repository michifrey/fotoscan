import { expect, test } from '@playwright/test';

/**
 * Der Blatt-Scan: erst die ganze Seite, dann das Telefon flach darüber
 * geführt. Geprüft wird der Weg – Übersicht, Karte, Kacheln, Zuschnitt,
 * Speichern –, nicht die Genauigkeit des Mitführens; die hat ihre eigenen
 * Messungen in `tests/lage.test.ts`.
 */
test('eine Seite abfahren und die Kacheln übernehmen', async ({ page }) => {
  const fehler: string[] = [];
  page.on('pageerror', (error) => fehler.push(error.message));

  await page.goto('/');
  await page.getByTestId('album-name').fill('Blatt für Blatt');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.videoWidth > 0);
  });

  // Automatik aus, damit der Test den Moment bestimmt.
  await page.getByRole('button', { name: /Auslöser/ }).click();
  await page.getByTestId('modus-blatt').click();
  await page.getByTestId('shutter').click();

  // Die Übersicht steht: Ab hier führt die Karte.
  const karte = page.getByTestId('karte');
  await expect(karte).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('deckung')).toBeVisible();
  await expect(page.getByTestId('kacheln')).toHaveText(/0 Kacheln/);

  // Auch hier von Hand auslösen. Der Auslöser wird frei, sobald die App
  // weiss, wo sie auf der Seite steht.
  await page.getByRole('button', { name: /Auslöser/ }).click();
  const auslöser = page.getByTestId('sweep-shutter');
  await expect(auslöser).toBeEnabled({ timeout: 30_000 });

  await auslöser.click();
  await expect(page.getByTestId('kacheln')).toHaveText(/1 Kachel$/);
  await auslöser.click();
  await expect(page.getByTestId('kacheln')).toHaveText(/2 Kacheln/);

  await page.getByTestId('sweep-done').click();

  // Zurück in der Prüfung, mit dem Hinweis auf den Blatt-Scan.
  await expect(page.getByRole('heading', { name: 'Zuschnitt prüfen' })).toBeVisible();
  await expect(page.getByTestId('blatt-hinweis')).toHaveText(/2 Kacheln/);

  await page.getByTestId('accept').click();
  await expect(page.getByTestId('shutter')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Zurück' }).click();
  await expect(page.getByText(/\d+ Foto/)).toBeVisible();

  expect(fehler).toEqual([]);
});

test('der Blatt-Scan lässt sich abbrechen', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('album-name').fill('Doch nicht');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.videoWidth > 0);
  });

  await page.getByRole('button', { name: /Auslöser/ }).click();
  await page.getByTestId('modus-blatt').click();
  await page.getByTestId('shutter').click();
  await expect(page.getByTestId('karte')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Abbrechen' }).click();
  // Zurück im Sucher – und der Auslöser wieder bedienbar.
  await expect(page.getByTestId('shutter')).toBeEnabled();
});
