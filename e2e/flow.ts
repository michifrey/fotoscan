import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Der Weg von der Aufnahme bis zur Fotoauswahl – zwei Stufen, wie in der App.
 *
 * Erst steht die **Seite** zur Prüfung: ihr Viereck über der Aufnahme, die
 * Ecken zu ziehen. Dann wird sie geradegerückt, und darauf sucht die App die
 * **Fotos**, durchnummeriert und zu ändern.
 */
export async function seiteBestaetigen(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Seite prüfen' })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('seite-weiter').click();
  await expect(page.getByRole('heading', { name: 'Fotos wählen' })).toBeVisible();
  // Die Suche läuft im Worker; abgewartet wird sie über den Hinweis darunter.
  await expect(page.getByTestId('fotos-hinweis')).not.toHaveText(/werden gesucht/, { timeout: 30_000 });
}

/** Wie viele Fotos die Auswahl gerade umfasst – am Knopf abzulesen. */
export function gewaehlt(page: Page) {
  return page.getByTestId('details');
}
