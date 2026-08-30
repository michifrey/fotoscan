import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { gewaehlt, seiteBestaetigen } from './flow';

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

  // Erst die Seite, dann die Fotos darauf – alle drei einzeln erkannt.
  await seiteBestaetigen(page);
  await expect(gewaehlt(page)).toHaveText('3 Fotos einzeln scannen');

  await page.getByTestId('accept').click();

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
  await seiteBestaetigen(page);
  await expect(gewaehlt(page)).toHaveText('3 Fotos einzeln scannen');

  await page.getByTestId('toggle-0').click();
  await expect(gewaehlt(page)).toHaveText('2 Fotos einzeln scannen');

  // Ein Tipp auf das Foto selbst ändert die Auswahl nicht, sondern zeigt die Ecken.
  // Neben dem Häkchen tippen, nicht darauf.
  await page.locator('svg polygon').nth(1).click({ position: { x: 20, y: 20 } });
  await expect(gewaehlt(page)).toHaveText('2 Fotos einzeln scannen');
  await expect(page.getByRole('button', { name: 'Ecke oben links' })).toBeVisible();

  await page.getByTestId('accept').click();
  await expect(page.getByTestId('shutter')).toBeVisible();
  await page.getByRole('button', { name: 'Zurück' }).click();
  await expect(page.getByText('2 Fotos')).toBeVisible();
});

test('ein übersehenes Foto mit einem Tipp aufnehmen', async ({ page }) => {
  // Der Fall, für den die zweite Stufe da ist: Was die Erkennung nicht findet,
  // holt der Nutzer selbst herein – es bekommt die nächste Nummer und lässt
  // sich an den Ecken zurechtziehen.
  await page.goto('/');
  await page.getByTestId('album-name').fill('Übersehen');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);
  await seiteBestaetigen(page);

  await expect(gewaehlt(page)).toHaveText('3 Fotos einzeln scannen');
  await expect(page.getByTestId('nummer-3')).toHaveCount(0);

  // Unten rechts auf der Seite steht blankes Papier.
  const frei = page.getByTestId('freie-flaeche');
  const box = (await frei.boundingBox())!;
  await frei.click({ position: { x: box.width * 0.84, y: box.height * 0.84 } });

  await expect(page.getByTestId('nummer-3')).toBeVisible();
  await expect(gewaehlt(page)).toHaveText('4 Fotos einzeln scannen');
  // Und es lässt sich sofort zurechtziehen.
  await expect(page.getByRole('button', { name: 'Ecke oben links' })).toBeVisible();

  await page.getByTestId('accept').click();
  await expect(page.getByTestId('shutter')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Zurück' }).click();
  await expect(page.getByText('4 Fotos')).toBeVisible();
});
