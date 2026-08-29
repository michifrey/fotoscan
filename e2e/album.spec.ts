import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./fixtures/albumseite.png', import.meta.url));

async function albumMitDreiFotos(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('album-name').fill(name);
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('accept')).toHaveText('3 Fotos speichern');
  await page.getByTestId('accept').click();
  await expect(page.getByTestId('shutter')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Zurück' }).click();
  await expect(page.getByTestId('count')).toHaveText('3 von 3 Fotos');
}

test('Foto beschriften, wiederfinden und die Beschriftung behalten', async ({ page }) => {
  await albumMitDreiFotos(page, 'Beschriften');

  await page.getByTestId('photo-0').click();
  await expect(page.getByTestId('viewer')).toBeVisible();
  await page.getByTestId('caption-open').click();
  await page.getByTestId('caption-title').fill('Oma im Garten');
  await page.getByTestId('caption-taken').fill('Sommer 1978');
  await page.getByTestId('caption-note').fill('Mit dem Hund vor dem Haus');
  await page.getByTestId('caption-save').click();

  // Die Beschriftung steht sofort unter dem Foto.
  await expect(page.getByTestId('viewer').getByText('Oma im Garten')).toBeVisible();
  await page.getByRole('button', { name: 'Schliessen' }).click();

  // Und sie ist durchsuchbar.
  await page.getByTestId('search').fill('hund');
  await expect(page.getByTestId('count')).toHaveText('1 von 3 Fotos');
  await page.getByTestId('search').fill('');
  await expect(page.getByTestId('count')).toHaveText('3 von 3 Fotos');

  // Auch nach einem Neustart der App.
  await page.reload();
  await expect(page.getByText('3 Fotos ·')).toBeVisible();
  await page.getByRole('button', { name: /Beschriften/ }).first().click();
  await page.getByTestId('search').fill('Sommer 1978');
  await expect(page.getByTestId('count')).toHaveText('1 von 3 Fotos');
});

test('die Handschrift von der Seite steht beim Foto', async ({ page }) => {
  await albumMitDreiFotos(page, 'Handschrift');

  // Unter dem ersten Foto der Vorlage steht eine Zeile. Sie wird beim Speichern
  // ausgeschnitten und liegt im Betrachter unter dem Bild.
  await page.getByTestId('photo-0').click();
  await expect(page.getByTestId('writing')).toBeVisible();

  // Im Beschriften-Blatt steht sie zum Abschreiben daneben.
  await page.getByTestId('caption-open').click();
  await expect(page.getByRole('img', { name: 'Handschrift von der Albumseite' }).last()).toBeVisible();
  await page.getByTestId('caption-title').fill('Abgeschrieben');
  await page.getByTestId('caption-save').click();
  await expect(page.getByTestId('viewer').getByText('Abgeschrieben')).toBeVisible();

  // Die anderen Fotos haben keine – und behaupten es auch nicht.
  await page.getByRole('button', { name: 'Schliessen' }).click();
  await page.getByTestId('photo-1').click();
  await expect(page.getByTestId('writing')).toHaveCount(0);
});

test('Fotos einer Albumseite bleiben zusammen', async ({ page }) => {
  await albumMitDreiFotos(page, 'Seiten');

  await page.getByTestId('tab-seiten').click();
  await expect(page.getByText('Albumseite 1')).toBeVisible();
  await expect(page.getByText('3 Fotos ·')).toBeVisible();

  // Aus dem Betrachter heraus lässt sich die ganze Seite ansehen.
  await page.getByTestId('tab-fotos').click();
  await page.getByTestId('photo-1').click();
  await page.getByTestId('page-open').click();
  await expect(page.getByRole('img', { name: 'Albumseite' })).toBeVisible();
});

test('Reihenfolge ändern und behalten', async ({ page }) => {
  await albumMitDreiFotos(page, 'Ordnen');

  // Das erste Foto bekommt einen Titel, damit es sich verfolgen lässt.
  await page.getByTestId('photo-0').click();
  await page.getByTestId('caption-open').click();
  await page.getByTestId('caption-title').fill('Erstes');
  await page.getByTestId('caption-save').click();
  await page.getByRole('button', { name: 'Schliessen' }).click();

  await page.getByTestId('order-toggle').click();
  const from = await page.getByTestId('photo-0').boundingBox();
  const to = await page.getByTestId('photo-2').boundingBox();
  if (!from || !to) throw new Error('Kacheln nicht gefunden');

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 30, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByTestId('photo-2')).toHaveAttribute('aria-label', 'Erstes öffnen');
  await page.getByTestId('order-toggle').click();

  await page.reload();
  await page.getByRole('button', { name: /Ordnen/ }).first().click();
  await expect(page.getByTestId('photo-2')).toHaveAttribute('aria-label', 'Erstes öffnen');
});

test('Album als Fotobuch weitergeben', async ({ page }) => {
  await albumMitDreiFotos(page, 'Buch');

  await page.getByTestId('export-open').click();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-book').click();
  const file = await download;

  expect(file.suggestedFilename()).toBe('Buch.pdf');
  const path = await file.path();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
  // Deckblatt, Übersichtsaufnahme der Seite und drei Fotos.
  expect(bytes.toString('latin1')).toContain('/Count 5');
});

test('Alben aus der ersten Fassung überstehen die Erweiterung', async ({ page }) => {
  // Auf dem Telefon liegen bereits Alben in der alten Datenbank – ohne Platz,
  // ohne Seite, ohne Beschriftung. Sie müssen die Erweiterung überleben.
  await page.goto('/manifest.webmanifest');
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('fotoscan', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('albums', { keyPath: 'id' });
        db.createObjectStore('scans', { keyPath: 'id' }).createIndex('albumId', 'albumId');
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['albums', 'scans'], 'readwrite');
        tx.objectStore('albums').put({ id: 'a1', name: 'Alte Fassung', createdAt: 1 });
        const pixel = new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' });
        tx.objectStore('scans').put({ id: 's2', albumId: 'a1', createdAt: 20, width: 4, height: 3, blob: pixel });
        tx.objectStore('scans').put({ id: 's1', albumId: 'a1', createdAt: 10, width: 4, height: 3, blob: pixel });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Alte Fassung/ }).first().click();
  await expect(page.getByTestId('count')).toHaveText('2 von 2 Fotos');
  // Die Reihenfolge kommt aus der Entstehungszeit, und Ordnen geht sofort.
  await page.getByTestId('order-toggle').click();
  await expect(page.getByTestId('photo-0')).toBeVisible();
});
