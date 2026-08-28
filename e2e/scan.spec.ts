import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./fixtures/albumseite.png', import.meta.url));

test('Albumseite einlesen, Fotos erkennen und speichern', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('album-name').fill('Ferien 1978');
  await page.getByTestId('create-album').click();

  await expect(page.getByRole('heading', { name: 'Ferien 1978' })).toBeVisible();
  await page.getByTestId('scan').click();

  // Ohne Kameraerlaubnis muss der Weg über die Galerie weiterhin funktionieren.
  await expect(page.getByText(/Kamera/)).toBeVisible();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);

  // Alle drei Fotos der Albumseite müssen einzeln erkannt worden sein.
  const accept = page.getByTestId('accept');
  await expect(accept).toHaveText('3 Fotos speichern');

  await accept.click();

  // Nach dem Speichern geht es zurück zur Aufnahme; im Album liegen drei Fotos.
  await expect(page.getByTestId('shutter')).toBeVisible();
  await page.getByRole('button', { name: 'Zurück' }).click();
  await expect(page.getByText('3 Fotos')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Foto 1' })).toBeVisible();

  // Die Fotos überleben einen Neustart der App.
  await page.reload();
  await expect(page.getByText('3 Fotos ·')).toBeVisible();
});

test('einzelnes Foto abwählen und nur die übrigen speichern', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('album-name').fill('Auswahl');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);

  const accept = page.getByTestId('accept');
  await expect(accept).toHaveText('3 Fotos speichern');

  await page.getByTestId('toggle-0').click();
  await expect(accept).toHaveText('2 Fotos speichern');

  // Ein Tipp auf das Foto selbst ändert die Auswahl nicht, sondern zeigt die Ecken.
  // Neben dem Häkchen tippen, nicht darauf.
  await page.locator('svg polygon').nth(1).click({ position: { x: 20, y: 20 } });
  await expect(accept).toHaveText('2 Fotos speichern');
  await expect(page.getByRole('button', { name: 'Ecke oben links' })).toBeVisible();

  await accept.click();
  await expect(page.getByTestId('shutter')).toBeVisible();
  await page.getByRole('button', { name: 'Zurück' }).click();
  await expect(page.getByText('2 Fotos')).toBeVisible();
});
