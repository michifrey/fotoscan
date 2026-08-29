import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./fixtures/albumseite.png', import.meta.url));

/**
 * Ein GitHub, das nur im Testlauf existiert. Es hält Inhalte, Bäume und
 * Commits so weit, wie die App sie braucht – und vergibt die Kennungen so, wie
 * Git es tut: als Prüfsumme über den Inhalt.
 */
function fakeGithub() {
  const blobs = new Map<string, string>();
  const trees = new Map<string, { path: string; type: string; sha: string }[]>();
  const commits = new Map<string, string>();
  let head: string | null = null;
  let counter = 0;

  const sha1 = (data: Buffer) => createHash('sha1').update(data).digest('hex');
  const gitSha = (content: string) => {
    const raw = Buffer.from(content, 'base64');
    return sha1(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw]));
  };

  return async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? (JSON.parse(request.postData()!) as Record<string, unknown>) : undefined;
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

    if (path === '/repos/michi/album') {
      return json({ default_branch: 'main', private: true, full_name: 'michi/album' });
    }
    if (path.endsWith('/git/ref/heads/main')) {
      return head ? json({ object: { sha: head } }) : json({ message: 'Not Found' }, 404);
    }
    if (path.includes('/git/commits/')) return json({ tree: { sha: commits.get(path.split('/').pop()!) } });
    if (path.includes('/git/trees/')) return json({ tree: trees.get(path.split('/').pop()!) ?? [] });
    if (path.includes('/git/blobs/')) {
      return json({ content: blobs.get(path.split('/').pop()!), encoding: 'base64' });
    }
    if (method === 'POST' && path.endsWith('/git/blobs')) {
      const content = String(body?.content);
      const sha = gitSha(content);
      blobs.set(sha, content);
      return json({ sha });
    }
    if (method === 'POST' && path.endsWith('/git/trees')) {
      const sha = `t${counter++}`;
      trees.set(sha, (body?.tree as { path: string; type: string; sha: string }[]).map((entry) => ({ ...entry })));
      return json({ sha });
    }
    if (method === 'POST' && path.endsWith('/git/commits')) {
      const sha = `c${counter++}`;
      commits.set(sha, String(body?.tree));
      return json({ sha });
    }
    if (method === 'POST' && path.endsWith('/git/refs')) {
      head = String(body?.sha);
      return json({});
    }
    if (method === 'PATCH' && path.includes('/git/refs/heads/')) {
      head = String(body?.sha);
      return json({});
    }
    return json({ message: `unerwartet: ${method} ${path}` }, 500);
  };
}

async function albumAnlegen(page: Page, name: string): Promise<void> {
  await page.getByTestId('album-name').fill(name);
  await page.getByTestId('create-album').click();
  await page.getByTestId('scan').click();
  await page.getByTestId('import-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('accept')).toHaveText('3 Fotos speichern');
  await page.getByTestId('accept').click();
  await expect(page.getByTestId('shutter')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Zurück' }).click();
}

async function zugang(page: Page): Promise<void> {
  await page.getByTestId('remote-owner').fill('michi');
  await page.getByTestId('remote-repo').fill('album');
  await page.getByTestId('remote-token').fill('github_pat_test');
}

test('Album sichern, auf einem leeren Gerät wiederherstellen', async ({ page }) => {
  await page.route('https://api.github.com/**', fakeGithub());
  await page.goto('/');
  await albumAnlegen(page, 'Ferien 1978');

  // Ein Foto beschriften – die Beschriftung muss die Reise mitmachen.
  await page.getByTestId('photo-0').click();
  await page.getByTestId('caption-open').click();
  await page.getByTestId('caption-title').fill('Oma im Garten');
  await page.getByTestId('caption-note').fill('Mit dem Hund vor dem Haus');
  await page.getByTestId('caption-save').click();
  await page.getByRole('button', { name: 'Schliessen' }).click();

  await page.getByTestId('export-open').click();
  await page.getByTestId('remote-open').click();
  await zugang(page);
  await page.getByTestId('remote-backup').click();
  await expect(page.getByTestId('remote-done')).toContainText('Gesichert', { timeout: 30_000 });

  // Ein zweites Sichern lädt nichts Neues hoch – die Prüfsummen stimmen längst.
  await page.getByTestId('remote-backup').click();
  await expect(page.getByTestId('remote-done')).toContainText('schon gesichert', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Schliessen' }).click();

  // Jetzt ein leeres Gerät: Datenbank weg, Token weg.
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('fotoscan');
      request.onsuccess = resolve;
      request.onerror = resolve;
      request.onblocked = resolve;
    });
  });
  await page.reload();
  await expect(page.getByText('Noch keine Alben')).toBeVisible();

  await page.getByTestId('fetch-album').click();
  await zugang(page);
  await page.getByTestId('remote-restore').click();

  // Album, Fotos, Beschriftung und Albumseite sind zurück.
  await expect(page.getByTestId('count')).toHaveText('3 von 3 Fotos', { timeout: 30_000 });
  await page.getByTestId('search').fill('Hund');
  await expect(page.getByTestId('count')).toHaveText('1 von 3 Fotos');
  await page.getByTestId('search').fill('');
  await page.getByTestId('tab-seiten').click();
  await expect(page.getByText('Albumseite 1')).toBeVisible();
  await page.getByTestId('tab-fotos').click();
  await page.getByTestId('photo-0').click();
  await expect(page.getByTestId('writing')).toBeVisible();
});

test('sagt verständlich, wenn der Token nicht angenommen wird', async ({ page }) => {
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"Bad credentials"}' }),
  );
  await page.goto('/');
  await albumAnlegen(page, 'Ohne Zugang');

  await page.getByTestId('export-open').click();
  await page.getByTestId('remote-open').click();
  await zugang(page);
  await page.getByTestId('remote-backup').click();

  await expect(page.getByTestId('remote-error')).toContainText('Token');
});
