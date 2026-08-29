import { describe, expect, it } from 'vitest';
import { buildFiles, MANIFEST, readFiles } from '../src/lib/backup';
import { fromBase64, gitSha, GithubError, pullFiles, pushFiles, toBase64 } from '../src/lib/github';
import type { Remote } from '../src/lib/github';
import type { Album, Page, Scan } from '../src/lib/storage';

const REMOTE: Remote = { owner: 'michi', repo: 'ferien-1978', token: 'geheim' };

function jpeg(marker: number): Blob {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, marker, 0xff, 0xd9])], { type: 'image/jpeg' });
}

const album: Album = { id: 'a1', name: 'Ferien 1978', createdAt: 1000 };

const pages: Page[] = [
  { id: 'p1', albumId: 'a1', createdAt: 1100, order: 0, width: 900, height: 700, blob: jpeg(9) },
];

const scans: Scan[] = [
  {
    id: 's1',
    albumId: 'a1',
    createdAt: 1200,
    order: 0,
    width: 800,
    height: 600,
    blob: jpeg(1),
    pageId: 'p1',
    title: 'Oma im Garten',
    taken: 'Sommer 1978',
    note: 'Mit dem Hund',
    writing: jpeg(7),
    writingWidth: 400,
    writingHeight: 90,
  },
  { id: 's2', albumId: 'a1', createdAt: 1300, order: 1, width: 800, height: 600, blob: jpeg(2), pageId: 'p1' },
];

/**
 * Ein GitHub, das nur im Speicher lebt: Es merkt sich Inhalte, Bäume und
 * Commits so weit, wie der Ablauf sie braucht.
 */
function fakeGithub(options: { empty?: boolean } = {}) {
  const blobs = new Map<string, string>();
  const trees = new Map<string, { path: string; type: string; sha: string }[]>();
  const commits = new Map<string, string>();
  let head: string | null = null;
  const calls: string[] = [];
  let counter = 0;
  const id = (prefix: string) => `${prefix}${(counter++).toString(16).padStart(4, '0')}`;

  const fetcher = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const path = String(url).replace('https://api.github.com', '');
    const method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

    if (path === '/repos/michi/ferien-1978') {
      return json({ default_branch: 'main', private: true, full_name: 'michi/ferien-1978' });
    }
    if (path.endsWith('/git/ref/heads/main')) {
      return head ? json({ object: { sha: head } }) : json({ message: 'Not Found' }, 404);
    }
    if (path.includes('/git/commits/')) {
      const sha = path.split('/').pop()!;
      return json({ tree: { sha: commits.get(sha) } });
    }
    if (path.includes('/git/trees/')) {
      const sha = path.split('/').pop()!.split('?')[0];
      return json({ tree: trees.get(sha) ?? [] });
    }
    if (path.includes('/git/blobs/')) {
      const sha = path.split('/').pop()!;
      return json({ content: blobs.get(sha), encoding: 'base64' });
    }
    if (method === 'POST' && path.endsWith('/git/blobs')) {
      // Wie bei GitHub ist die Kennung eines Inhalts seine Git-Prüfsumme –
      // daran hängt, dass beim zweiten Sichern nichts doppelt hochgeht.
      const content = String(body?.content);
      const sha = await gitSha(fromBase64(content));
      blobs.set(sha, content);
      return json({ sha });
    }
    if (method === 'POST' && path.endsWith('/git/trees')) {
      const sha = id('t');
      trees.set(sha, body?.tree as { path: string; type: string; sha: string }[]);
      // Der Baum merkt sich, welcher Inhalt zu welchem Pfad gehört.
      for (const entry of trees.get(sha)!) entry.type = 'blob';
      return json({ sha });
    }
    if (method === 'POST' && path.endsWith('/git/commits')) {
      const sha = id('c');
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

  if (options.empty === false) head = null;
  return { fetcher: fetcher as unknown as typeof fetch, calls, blobs };
}

describe('Sicherung', () => {
  it('rechnet dieselbe Prüfsumme aus wie Git', async () => {
    // Gegenprobe mit `git hash-object`: Nur wenn die Zahl stimmt, erkennt die
    // App wieder, was schon oben liegt – und lädt beim zweiten Mal nichts doppelt.
    expect(await gitSha(new TextEncoder().encode('hallo\n'))).toBe('4cf5aa5f9a644263dbe3d6e78bcbef45487a802c');
    expect(await gitSha(new Uint8Array(0))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(await gitSha(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe('6bd169662e6f0a618e42842027f94f75bf6c38e5');
  });

  it('macht aus dem Album Dateien und aus den Dateien wieder das Album', async () => {
    const files = await buildFiles(album, scans, pages);

    expect(files.map((file) => file.path)).toEqual([
      'seiten/001-p1.jpg',
      'fotos/0001-Oma-im-Garten.jpg',
      'handschrift/0001-Oma-im-Garten.jpg',
      'fotos/0002-s2.jpg',
      MANIFEST,
    ]);

    const back = readFiles(files);
    expect(back.name).toBe('Ferien 1978');
    expect(back.photos).toHaveLength(2);
    expect(back.photos[0].title).toBe('Oma im Garten');
    expect(back.photos[0].taken).toBe('Sommer 1978');
    expect(back.photos[0].note).toBe('Mit dem Hund');
    expect(back.photos[0].pageId).toBe('p1');
    expect(back.photos[0].writingWidth).toBe(400);
    expect(back.photos[1].order).toBe(1);
    expect(back.pages).toHaveLength(1);
    expect(back.pages[0].id).toBe('p1');
  });

  it('überspringt Einträge, deren Bild fehlt', async () => {
    const files = await buildFiles(album, scans, pages);
    const ohne = files.filter((file) => file.path !== 'fotos/0002-s2.jpg');

    const back = readFiles(ohne);

    expect(back.photos).toHaveLength(1);
    expect(back.photos[0].id).toBe('s1');
  });

  it('legt im leeren Repository den Zweig an und lädt alles hoch', async () => {
    const github = fakeGithub();
    const files = await buildFiles(album, scans, pages);

    const result = await pushFiles(REMOTE, files, 'Ferien 1978, 2 Fotos', { fetcher: github.fetcher });

    expect(result.uploaded).toBe(files.length);
    // Ohne Zweig muss er angelegt werden, nicht verschoben.
    expect(github.calls).toContain('POST /repos/michi/ferien-1978/git/refs');
    expect(github.calls.some((call) => call.startsWith('PATCH'))).toBe(false);
  });

  it('lädt beim zweiten Sichern nur das Geänderte hoch', async () => {
    const github = fakeGithub();
    const files = await buildFiles(album, scans, pages);
    await pushFiles(REMOTE, files, 'erste Sicherung', { fetcher: github.fetcher });

    const geaendert = [...scans];
    geaendert[1] = { ...scans[1], title: undefined, note: 'nachträglich beschriftet' };
    const zweite = await buildFiles(album, geaendert, pages);

    const before = github.calls.length;
    const result = await pushFiles(REMOTE, zweite, 'zweite Sicherung', { fetcher: github.fetcher });

    // Nur die album.json hat sich geändert; die Bilder liegen längst oben.
    expect(result.uploaded).toBe(1);
    const uploads = github.calls.slice(before).filter((call) => call.endsWith('/git/blobs'));
    expect(uploads).toHaveLength(1);
    // Und der Zweig wird jetzt weitergeschoben statt neu angelegt.
    expect(github.calls.slice(before).some((call) => call.startsWith('PATCH'))).toBe(true);
  });

  it('holt das Album vollständig zurück', async () => {
    const github = fakeGithub();
    const files = await buildFiles(album, scans, pages);
    await pushFiles(REMOTE, files, 'Sicherung', { fetcher: github.fetcher });

    const geholt = await pullFiles(REMOTE, { fetcher: github.fetcher });
    const back = readFiles(geholt);

    expect(geholt.map((file) => file.path).sort()).toEqual(files.map((file) => file.path).sort());
    expect(back.photos.map((photo) => photo.title)).toEqual(['Oma im Garten', undefined]);
    expect(await back.photos[0].blob.arrayBuffer()).toEqual(await scans[0].blob.arrayBuffer());
  });

  it('sagt verständlich, was mit dem Token nicht stimmt', async () => {
    const fetcher = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;

    await expect(pushFiles(REMOTE, [], 'x', { fetcher })).rejects.toThrow(/Token/);
    await expect(pullFiles(REMOTE, { fetcher })).rejects.toBeInstanceOf(GithubError);
  });

  it('trägt beliebige Bytes durch die Base64-Umrechnung', () => {
    const data = new Uint8Array(1000).map((_, index) => (index * 37) % 256);
    expect(fromBase64(toBase64(data))).toEqual(data);
  });
});
