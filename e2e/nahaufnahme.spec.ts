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

test('der Auslöser führt immer weiter, auch wenn nichts erkannt wird', async ({ page }) => {
  // Der Fehler, den dieser Ablauf festhält: Am echten Album fand die Erkennung
  // in der Nahaufnahme nichts, und der Auslöser tat daraufhin *gar nichts* –
  // kein Bild, kein Weiterkommen, nur ein Hinweis. Die Stufe war damit nicht
  // bloss ungenau, sondern unbenutzbar.
  //
  // Vor der Kamera liegt hier ein Testmuster, kein Abzug auf Albumpapier. Genau
  // deshalb taugt es: Es ist der ungünstigste Fall, und auch der muss
  // weiterführen.
  await page.goto('/');
  await page.getByTestId('album-name').fill('Auslöser');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByRole('button', { name: /Auslöser/ }).click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);
  await seiteBestaetigen(page);

  await page.getByTestId('details').click();
  await expect(page.getByText('Foto 1 · 1 von 3')).toBeVisible();
  // Auch hier von Hand, damit der Test den Moment bestimmt.
  await page.getByRole('button', { name: /Auslöser/ }).click();
  // Und erst, wenn die Kamera wirklich Bilder liefert – vorher gäbe es nichts
  // aufzunehmen, und der Test prüfte die falsche Sache.
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.videoWidth > 0);
  }, undefined, { timeout: 30_000 });

  await page.getByTestId('closeup-shutter').click();

  // Entweder die Seitenaufnahme hat ihr Foto wiedererkannt – dann geht es
  // sofort weiter –, oder der Zuschnitt will bestätigt werden. Beides ist ein
  // Weiterkommen; Stillstand ist es nicht.
  const nachfrage = page.getByTestId('nah-nachfrage');
  await expect(nachfrage.or(page.getByText('Foto 2 · 2 von 3'))).toBeVisible({ timeout: 60_000 });
  if (await nachfrage.isVisible()) await page.getByTestId('nah-uebernehmen').click();
  await expect(page.getByText('Foto 2 · 2 von 3')).toBeVisible({ timeout: 30_000 });
});

test('die Übersicht führt durch die Seite und lässt springen', async ({ page }) => {
  // Bisher stand hier nur „Foto 3 von 5". Das sagt nichts darüber, *welcher*
  // Abzug auf der Seite gemeint ist, und nichts darüber, was noch aussteht.
  // Die Landkarte sagt beides – und lässt die Reihenfolge frei.
  await page.goto('/');
  await page.getByTestId('album-name').fill('Übersicht');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByRole('button', { name: /Auslöser/ }).click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);
  await seiteBestaetigen(page);

  await page.getByTestId('details').click();
  await expect(page.getByText('Foto 1 · 1 von 3')).toBeVisible();
  await expect(page.getByTestId('karte-stand')).toHaveText(/0 von 3/);

  // Alle drei stehen auf der Karte, jedes mit seiner Nummer.
  for (const i of [0, 1, 2]) {
    await expect(page.getByTestId(`karte-${i}`)).toBeVisible();
  }

  // Ein Tipp auf das dritte springt dorthin – ohne die beiden davor.
  await page.getByTestId('karte-2').click();
  await expect(page.getByText('Foto 3 · 3 von 3')).toBeVisible();

  // Und zurück auf das erste.
  await page.getByTestId('karte-0').click();
  await expect(page.getByText('Foto 1 · 1 von 3')).toBeVisible();
});

test('ein übersprungenes Foto kommt nicht sofort wieder, bleibt aber erreichbar', async ({ page }) => {
  // Der Grund, warum „weiter" nicht mehr stur die nächste Nummer nimmt: Ein
  // übersprungenes stünde sonst gleich wieder an, ein schon aufgenommenes
  // ein zweites Mal.
  await page.goto('/');
  await page.getByTestId('album-name').fill('Auslassen');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByRole('button', { name: /Auslöser/ }).click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);
  await seiteBestaetigen(page);

  await page.getByTestId('details').click();
  await page.getByRole('button', { name: 'Überspringen' }).click();
  await expect(page.getByText('Foto 2 · 2 von 3')).toBeVisible();

  // Über die Karte ist es weiterhin zu erreichen.
  await page.getByTestId('karte-0').click();
  await expect(page.getByText('Foto 1 · 1 von 3')).toBeVisible();

  // Und der Fall, an dem sich zeigt, dass „weiter" wirklich das nächste
  // **offene** sucht: Vom letzten aus übersprungen geht es nicht ans Ende,
  // sondern zurück zu dem, das noch aussteht.
  await page.getByTestId('karte-2').click();
  await expect(page.getByText('Foto 3 · 3 von 3')).toBeVisible();
  await page.getByRole('button', { name: 'Überspringen' }).click();
  await expect(page.getByText('Foto 1 · 1 von 3')).toBeVisible();
});

