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

test('die Ecken der Seite antippen', async ({ page }) => {
  // Seidenpapier, Albumseite und lose Blätter darunter sind dasselbe Papier –
  // die Erkennung kann sie nicht auseinanderhalten. Dann setzt sie der Nutzer
  // eben selbst: vier Tipps, und das Viereck steht.
  await page.goto('/');
  await page.getByTestId('album-name').fill('Ecken setzen');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);
  await expect(page.getByRole('heading', { name: 'Seite prüfen' })).toBeVisible({ timeout: 30_000 });

  // Alle vier Ecken müssen greifbar sein – eine ausserhalb des Bildes wäre es
  // nicht, und genau das ist am echten Album passiert.
  for (const ecke of ['oben links', 'oben rechts', 'unten rechts', 'unten links']) {
    await expect(page.getByRole('button', { name: `Ecke ${ecke}` })).toBeVisible();
  }

  await page.getByTestId('ecken-setzen').click();
  await expect(page.getByTestId('seite-hinweis')).toHaveText(/oben links.*1 von 4/);
  // Solange gesetzt wird, geht es nicht weiter.
  await expect(page.getByTestId('seite-weiter')).toBeDisabled();

  const flaeche = page.getByTestId('ecken-tippen');
  const box = (await flaeche.boundingBox())!;
  const ecken = [
    [0.1, 0.09],
    [0.9, 0.09],
    [0.9, 0.91],
    [0.1, 0.91],
  ];
  for (const [x, y] of ecken) {
    await flaeche.click({ position: { x: box.width * x, y: box.height * y } });
  }

  // Danach steht das Viereck, und es geht weiter.
  await expect(page.getByTestId('seite-hinweis')).toHaveText(/Ecken ziehen/);
  await expect(page.getByTestId('seite-weiter')).toBeEnabled();

  await page.getByTestId('seite-weiter').click();
  await expect(page.getByRole('heading', { name: 'Fotos wählen' })).toBeVisible();
  await expect(page.getByTestId('fotos-hinweis')).not.toHaveText(/werden gesucht/, { timeout: 30_000 });
  await expect(gewaehlt(page)).toHaveText('3 Fotos einzeln scannen');
});

test('die geprüften Vierecke der Seite werden mitgespeichert', async ({ page }) => {
  // Was der Nutzer in der zweiten Stufe bestätigt, ist eine von Hand geprüfte
  // Wahrheit – und bisher wurde sie nach dem Speichern weggeworfen. Dieser
  // Ablauf hält fest, dass sie in der Datenbank ankommt: Ohne ihn könnte die
  // Verkabelung reissen, ohne dass ein einziger Test rot würde.
  await page.goto('/');
  await page.getByTestId('album-name').fill('Marken');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);

  await seiteBestaetigen(page);
  await expect(gewaehlt(page)).toHaveText('3 Fotos einzeln scannen');
  await page.getByTestId('accept').click();
  await expect(page.getByTestId('shutter')).toBeVisible({ timeout: 60_000 });

  const seiten = await page.evaluate(
    () =>
      new Promise<{ width: number; height: number; marks?: { page: unknown[]; photos: unknown[][] } }[]>(
        (resolve, reject) => {
          const request = indexedDB.open('fotoscan', 2);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const all = request.result.transaction('pages', 'readonly').objectStore('pages').getAll();
            all.onsuccess = () => resolve(all.result);
            all.onerror = () => reject(all.error);
          };
        },
      ),
  );

  expect(seiten).toHaveLength(1);
  const marks = seiten[0].marks;
  expect(marks).toBeDefined();
  // Ein Viereck für die Seite, und je eines für die drei gewählten Fotos.
  expect(marks!.page).toHaveLength(4);
  expect(marks!.photos).toHaveLength(3);

  // Und sie liegen im gespeicherten Seitenbild, nicht in der vollen Aufnahme –
  // die gibt es nach dem Speichern nicht mehr.
  for (const quad of [marks!.page, ...marks!.photos]) {
    for (const point of quad as { x: number; y: number }[]) {
      expect(point.x).toBeGreaterThanOrEqual(-1);
      expect(point.y).toBeGreaterThanOrEqual(-1);
      expect(point.x).toBeLessThanOrEqual(seiten[0].width + 1);
      expect(point.y).toBeLessThanOrEqual(seiten[0].height + 1);
    }
  }
});

test('die Lupe zeigt, wohin die Ecke kommt', async ({ page }) => {
  // Der Finger verdeckt genau die Stelle, auf die es ankommt, und die Kante
  // einer Albumseite ist auf einem Telefonbildschirm ein Haar breit. Die Lupe
  // erscheint, solange gedrückt wird, und verschwindet beim Loslassen –
  // gesetzt wird die Ecke erst dann, bis dahin lässt sie sich schieben.
  await page.goto('/');
  await page.getByTestId('album-name').fill('Lupe');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);
  await expect(page.getByRole('heading', { name: 'Seite prüfen' })).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('ecken-setzen').click();
  const flaeche = page.getByTestId('ecken-tippen');
  const box = (await flaeche.boundingBox())!;

  await expect(page.getByTestId('lupe')).toHaveCount(0);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await expect(page.getByTestId('lupe')).toBeVisible();

  // Beim Schieben bleibt sie stehen und folgt der Stelle.
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.22);
  await expect(page.getByTestId('lupe')).toBeVisible();

  await page.mouse.up();
  await expect(page.getByTestId('lupe')).toHaveCount(0);
  // Und die erste Ecke ist gesetzt – es geht zur zweiten.
  await expect(page.getByTestId('seite-hinweis')).toHaveText(/oben rechts.*2 von 4/);
});
