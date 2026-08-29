import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Eine Telefonhaltung nachstellen. Erst danach gilt der Lagesensor als aktiv. */
async function neige(page: Page, beta: number, gamma: number): Promise<void> {
  await page.evaluate(
    ([b, g]) => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { beta: b, gamma: g, alpha: 0 }));
    },
    [beta, gamma],
  );
  // Die Werte werden pro Bildwiederholung übernommen.
  await page.waitForTimeout(120);
}

test('vier Punkte abfahren und daraus ein entspiegeltes Foto rechnen', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('album-name').fill('Entspiegelt');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();

  // Warten, bis das Kamerabild wirklich läuft – sonst gibt es nichts aufzunehmen.
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.videoWidth > 0);
  });

  // Auf manuelles Auslösen umstellen, damit der Test den Moment bestimmt.
  await page.getByRole('button', { name: /Auslöser/ }).click();
  await expect(page.getByRole('button', { name: /Auslöser: manuell/ })).toBeVisible();

  await page.getByTestId('shutter').click();

  // Die vier Punkte erscheinen, noch ist keiner abgehakt.
  await expect(page.getByTestId('ziel-0')).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await expect(page.getByTestId(`ziel-${i}`)).toHaveAttribute('data-erledigt', 'nein');
  }

  // Die Punkte hängen am Motiv: Solange die Kamera es im Blick hat, gilt es
  // als gefunden – und nur dann wird überhaupt ausgelöst.
  await expect(page.getByTestId('motiv')).toHaveAttribute('data-verloren', 'nein');

  // Ausgangshaltung setzen, dann die vier Punkte anfahren:
  // oben, rechts, unten, links. 11 Grad entsprechen der vollen Auslenkung.
  await neige(page, 0, 0);
  await expect(page.getByTestId('ring')).toBeVisible();

  await neige(page, -11, 0);
  await expect(page.getByTestId('ziel-0')).toHaveAttribute('data-erledigt', 'ja');

  await neige(page, 0, 11);
  await expect(page.getByTestId('ziel-1')).toHaveAttribute('data-erledigt', 'ja');

  await neige(page, 11, 0);
  await expect(page.getByTestId('ziel-2')).toHaveAttribute('data-erledigt', 'ja');

  await neige(page, 0, -11);

  // Nach dem vierten Punkt geht es von selbst zur Prüfung des Zuschnitts.
  await expect(page.getByRole('heading', { name: 'Zuschnitt prüfen' })).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('accept').click();
  await expect(page.getByTestId('shutter')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Zurück' }).click();
  await expect(page.getByText(/^1 Foto$/)).toBeVisible();
});

test('ohne Lagesensor übernimmt die Zeitsteuerung', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('album-name').fill('Ohne Sensor');
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.videoWidth > 0);
  });
  await page.getByRole('button', { name: /Auslöser/ }).click();

  await page.getByTestId('shutter').click();
  await expect(page.getByTestId('ziel-0')).toBeVisible();

  // Es werden keine Neigungswerte geschickt. Nach der Wartezeit muss die App
  // von selbst auf die zeitgesteuerte Reihe umschalten.
  await expect(page.getByRole('heading', { name: 'Zuschnitt prüfen' })).toBeVisible({ timeout: 40_000 });
});
