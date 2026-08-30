import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { gewaehlt, seiteBestaetigen } from './flow';

const FIXTURE = fileURLToPath(new URL('./fixtures/albumseite.png', import.meta.url));

test('Nahaufnahmen der Reihe nach durchgehen und überspringen', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('album-name').fill('Nah dran');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();

  // Automatik aus, damit der Test den Moment bestimmt.
  await page.getByRole('button', { name: /Auslöser/ }).click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);

  await seiteBestaetigen(page);
  await expect(gewaehlt(page)).toHaveText('3 Fotos einzeln scannen');

  // Die dritte Stufe: eine Nahaufnahme je Foto, in Leserichtung.
  await page.getByTestId('details').click();
  await expect(page.getByText('Foto 1 · 1 von 3')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Foto 1' })).toBeVisible();

  // Wer eine überspringt, bekommt für dieses Foto den Zuschnitt der
  // Seitenaufnahme – die Runde bleibt freiwillig, Foto für Foto.
  await page.getByRole('button', { name: 'Überspringen' }).click();
  await expect(page.getByText('Foto 2 · 2 von 3')).toBeVisible();
  await page.getByRole('button', { name: 'Überspringen' }).click();
  await expect(page.getByText('Foto 3 · 3 von 3')).toBeVisible();

  // Nach der letzten wird gespeichert – die Runde ist der letzte Schritt.
  await page.getByRole('button', { name: 'Überspringen' }).click();
  await expect(page.getByTestId('shutter')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Zurück' }).click();
  await expect(page.getByText('3 Fotos')).toBeVisible();
});

test('die Nahaufnahmen-Runde lässt sich abbrechen', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('album-name').fill('Abbruch');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByRole('button', { name: /Auslöser/ }).click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);
  await seiteBestaetigen(page);

  await page.getByTestId('details').click();
  await expect(page.getByText('Foto 1 · 1 von 3')).toBeVisible();

  await page.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(page.getByRole('heading', { name: 'Fotos wählen' })).toBeVisible();
});
