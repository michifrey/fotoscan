import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./fixtures/albumseite.png', import.meta.url));

test('Nahaufnahmen der Reihe nach durchgehen und überspringen', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('album-name').fill('Nah dran');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();

  // Automatik aus, damit der Test den Moment bestimmt.
  await page.getByRole('button', { name: /Auslöser/ }).click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);

  await expect(page.getByTestId('accept')).toHaveText('3 Fotos speichern');

  // Die dritte Runde: eine Nahaufnahme je Foto, in Leserichtung.
  await page.getByTestId('closeups').click();
  await expect(page.getByText('Nahaufnahme 1 von 3')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Foto 1' })).toBeVisible();

  // Wer eine überspringt, bekommt für dieses Foto den Zuschnitt der
  // Seitenaufnahme – die Runde bleibt freiwillig, Foto für Foto.
  await page.getByRole('button', { name: 'Überspringen' }).click();
  await expect(page.getByText('Nahaufnahme 2 von 3')).toBeVisible();
  await page.getByRole('button', { name: 'Überspringen' }).click();
  await expect(page.getByText('Nahaufnahme 3 von 3')).toBeVisible();
  await page.getByRole('button', { name: 'Überspringen' }).click();

  // Nach der letzten geht es zurück zur Prüfung, und Speichern geht weiter.
  await expect(page.getByRole('heading', { name: 'Zuschnitt prüfen' })).toBeVisible();
  await page.getByTestId('accept').click();

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
  await expect(page.getByTestId('accept')).toBeVisible();

  await page.getByTestId('closeups').click();
  await expect(page.getByText('Nahaufnahme 1 von 3')).toBeVisible();

  await page.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(page.getByRole('heading', { name: 'Zuschnitt prüfen' })).toBeVisible();
});
