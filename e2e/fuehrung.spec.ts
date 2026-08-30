import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { gewaehlt, seiteBestaetigen } from './flow';

const FIXTURE = fileURLToPath(new URL('./fixtures/albumseite.png', import.meta.url));

/**
 * Die Führung der Nahaufnahme – mit einer Kamera, die die Albumseite zeigt.
 *
 * Chromiums eingebautes Testbild ist eine fast einfarbige Fläche; darauf lässt
 * sich nichts wiederfinden, und genau auf dem Wiederfinden stehen Führung und
 * Duplikatsperre. Dieses Projekt spielt darum die Albumseite selbst als
 * Kamerabild ein (Y4M) – dieselbe Seite, die vorher in Stufe 1 importiert
 * wird. Die Kamera „sieht" also von weitem die Seite mit ihren drei Fotos.
 */

async function inDieDritteStufe(page: Page) {
  await page.goto('/');
  await page.getByTestId('album-name').fill('Führung');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByRole('button', { name: /Auslöser/ }).click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);
  await seiteBestaetigen(page);
  await expect(gewaehlt(page)).toHaveText('3 Fotos einzeln scannen');
  await page.getByTestId('details').click();
  await expect(page.getByText('Foto 1 · 1 von 3')).toBeVisible();
  await page.getByRole('button', { name: /Auslöser/ }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.videoWidth > 0);
  }, undefined, { timeout: 30_000 });
}

test('der Sucher führt: von weitem heisst es näher heran, nicht schweigen', async ({ page }) => {
  // Der Satz vom echten Album: „Eigentlich müsste mir die App sagen, ich soll
  // näher ran, und mich führen." Die Kamera steht hier weit weg – die ganze
  // Seite ist im Bild. Vorher stand dann „Foto ganz ins Bild nehmen"; jetzt
  // muss eine Ortsangabe kommen: näher heran, es ist markiert.
  await inDieDritteStufe(page);
  await expect(page.getByTestId('nah-status')).toHaveText(/Näher heran/, { timeout: 60_000 });
});

test('dieselbe Aufnahme ein zweites Mal löst eine Warnung aus', async ({ page }) => {
  // Die Antwort auf „lässt mich dreimal dasselbe Foto aufnehmen": Vor der
  // Übernahme wird der Zuschnitt gegen die schon übernommenen gehalten. Die
  // Fake-Kamera zeigt immer dasselbe Testmuster – genau der Fall.
  await page.goto('/');
  await page.getByTestId('album-name').fill('Doppelt');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByRole('button', { name: /Auslöser/ }).click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);
  await seiteBestaetigen(page);

  await page.getByTestId('details').click();
  await expect(page.getByText('Foto 1 · 1 von 3')).toBeVisible();
  await page.getByRole('button', { name: /Auslöser/ }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.videoWidth > 0);
  }, undefined, { timeout: 30_000 });

  // Erste Aufnahme: keine Warnung, übernehmen.
  await page.getByTestId('closeup-shutter').click();
  await expect(page.getByTestId('nah-nachfrage')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('nah-warnung')).toHaveCount(0);
  await page.getByTestId('nah-uebernehmen').click();
  await expect(page.getByText('Foto 2 · 2 von 3')).toBeVisible({ timeout: 30_000 });

  // Zweite Aufnahme desselben Bildes: die Warnung steht da – und die Wahl
  // bleibt beim Nutzer, denn Zwillingsabzüge gibt es wirklich.
  await page.getByTestId('closeup-shutter').click();
  await expect(page.getByTestId('nah-nachfrage')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('nah-warnung')).toContainText('Foto 1');
  await page.getByTestId('nah-nochmal').click();
  await expect(page.getByText('Foto 2 · 2 von 3')).toBeVisible();
});
