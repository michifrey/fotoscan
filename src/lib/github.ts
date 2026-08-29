/**
 * Ein Album in ein eigenes, privates GitHub-Repository sichern – und von dort
 * zurückholen.
 *
 * Gesichert wird nicht Datei für Datei, sondern als Git-Baum: erst die fehlenden
 * Inhalte hochladen, dann ein Baum, dann ein Commit. Das gibt je Sicherung
 * genau einen Eintrag in der Geschichte, und wer zweimal sichert, lädt beim
 * zweiten Mal fast nichts mehr hoch – die Prüfsumme jeder Datei lässt sich hier
 * ausrechnen und mit dem vergleichen, was schon oben liegt.
 */

export interface Remote {
  owner: string;
  repo: string;
  token: string;
  branch?: string;
}

export interface RemoteFile {
  path: string;
  data: Uint8Array;
}

export interface PushProgress {
  done: number;
  total: number;
  /** Was gerade hochgeladen wird – oder was übersprungen wurde. */
  path: string;
}

const API = 'https://api.github.com';

/** Damit sich der Ablauf ohne Netz prüfen lässt. */
export type Fetcher = typeof fetch;

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

interface Options {
  fetcher?: Fetcher;
  onProgress?: (progress: PushProgress) => void;
}

async function call<T>(remote: Remote, path: string, init: RequestInit = {}, fetcher: Fetcher = fetch): Promise<T> {
  const response = await fetcher(`${API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${remote.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new GithubError(await describe(response), response.status);
  }
  return (await response.json()) as T;
}

/** Aus einer Fehlerantwort einen Satz machen, der weiterhilft. */
async function describe(response: Response): Promise<string> {
  if (response.status === 401) return 'Der Token wird nicht angenommen. Ist er abgelaufen oder widerrufen?';
  if (response.status === 403) return 'Zugriff verweigert. Hat der Token das Recht „Contents: Lesen und Schreiben“?';
  if (response.status === 404) return 'Kein Zugriff auf dieses Repository – Name falsch, oder der Token gilt nicht dafür.';
  if (response.status === 409) return 'Das Repository ist noch leer oder der Zweig stimmt nicht.';
  let detail = '';
  try {
    const body = (await response.json()) as { message?: string };
    detail = body.message ? `: ${body.message}` : '';
  } catch {
    detail = '';
  }
  return `GitHub meldet ${response.status}${detail}`;
}

interface RepoInfo {
  default_branch: string;
  private: boolean;
  full_name: string;
}

/** Prüft Zugang und Zweig, bevor irgendetwas hochgeladen wird. */
export async function checkRepo(remote: Remote, options: Options = {}): Promise<RepoInfo> {
  return call<RepoInfo>(remote, `/repos/${remote.owner}/${remote.repo}`, {}, options.fetcher);
}

/**
 * Die Prüfsumme, die Git einer Datei gibt: SHA-1 über „blob <Länge>\\0" und den
 * Inhalt. Damit lässt sich vor dem Hochladen feststellen, was schon oben liegt.
 */
export async function gitSha(data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${data.length}\0`);
  const full = new Uint8Array(header.length + data.length);
  full.set(header, 0);
  full.set(data, header.length);
  const digest = await crypto.subtle.digest('SHA-1', full as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface TreeEntry {
  path: string;
  mode: '100644';
  type: 'blob';
  sha: string;
}

/**
 * Sichert den ganzen Stand: alle übergebenen Dateien, sonst nichts. Was oben
 * liegt und hier fehlt, verschwindet im neuen Baum – so bleibt das Repository
 * ein Abbild des Albums und nicht eine Halde alter Fassungen.
 */
export async function pushFiles(
  remote: Remote,
  files: RemoteFile[],
  message: string,
  options: Options = {},
): Promise<{ commit: string; uploaded: number }> {
  const fetcher = options.fetcher ?? fetch;
  const info = await checkRepo(remote, options);
  const branch = remote.branch ?? info.default_branch ?? 'main';

  const head = await headCommit(remote, branch, fetcher);
  const known = head ? await treePaths(remote, head.tree, fetcher) : new Map<string, string>();

  const entries: TreeEntry[] = [];
  let uploaded = 0;
  let done = 0;

  for (const file of files) {
    const sha = await gitSha(file.data);
    if (known.get(file.path) !== sha) {
      const blob = await call<{ sha: string }>(
        remote,
        `/repos/${remote.owner}/${remote.repo}/git/blobs`,
        { method: 'POST', body: JSON.stringify({ content: toBase64(file.data), encoding: 'base64' }) },
        fetcher,
      );
      entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
      uploaded++;
    } else {
      entries.push({ path: file.path, mode: '100644', type: 'blob', sha });
    }
    done++;
    options.onProgress?.({ done, total: files.length, path: file.path });
  }

  const tree = await call<{ sha: string }>(
    remote,
    `/repos/${remote.owner}/${remote.repo}/git/trees`,
    { method: 'POST', body: JSON.stringify({ tree: entries }) },
    fetcher,
  );

  const commit = await call<{ sha: string }>(
    remote,
    `/repos/${remote.owner}/${remote.repo}/git/commits`,
    {
      method: 'POST',
      body: JSON.stringify({ message, tree: tree.sha, parents: head ? [head.commit] : [] }),
    },
    fetcher,
  );

  if (head) {
    await call(
      remote,
      `/repos/${remote.owner}/${remote.repo}/git/refs/heads/${branch}`,
      { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) },
      fetcher,
    );
  } else {
    // Ein frisches, leeres Repository hat noch keinen Zweig.
    await call(
      remote,
      `/repos/${remote.owner}/${remote.repo}/git/refs`,
      { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) },
      fetcher,
    );
  }

  return { commit: commit.sha, uploaded };
}

/** Holt alle Dateien des letzten Standes zurück. */
export async function pullFiles(
  remote: Remote,
  options: Options = {},
): Promise<RemoteFile[]> {
  const fetcher = options.fetcher ?? fetch;
  const info = await checkRepo(remote, options);
  const branch = remote.branch ?? info.default_branch ?? 'main';

  const head = await headCommit(remote, branch, fetcher);
  if (!head) throw new GithubError('In diesem Repository liegt noch keine Sicherung.', 404);

  const paths = await treePaths(remote, head.tree, fetcher);
  const files: RemoteFile[] = [];
  let done = 0;

  for (const [path, sha] of paths) {
    const blob = await call<{ content: string; encoding: string }>(
      remote,
      `/repos/${remote.owner}/${remote.repo}/git/blobs/${sha}`,
      {},
      fetcher,
    );
    files.push({ path, data: fromBase64(blob.content) });
    done++;
    options.onProgress?.({ done, total: paths.size, path });
  }
  return files;
}

async function headCommit(
  remote: Remote,
  branch: string,
  fetcher: Fetcher,
): Promise<{ commit: string; tree: string } | null> {
  try {
    const ref = await call<{ object: { sha: string } }>(
      remote,
      `/repos/${remote.owner}/${remote.repo}/git/ref/heads/${branch}`,
      {},
      fetcher,
    );
    const commit = await call<{ tree: { sha: string } }>(
      remote,
      `/repos/${remote.owner}/${remote.repo}/git/commits/${ref.object.sha}`,
      {},
      fetcher,
    );
    return { commit: ref.object.sha, tree: commit.tree.sha };
  } catch (error) {
    // 404 und 409 heissen hier dasselbe: Es gibt noch nichts.
    if (error instanceof GithubError && (error.status === 404 || error.status === 409)) return null;
    throw error;
  }
}

async function treePaths(remote: Remote, tree: string, fetcher: Fetcher): Promise<Map<string, string>> {
  const result = await call<{ tree: { path: string; type: string; sha: string }[] }>(
    remote,
    `/repos/${remote.owner}/${remote.repo}/git/trees/${tree}?recursive=1`,
    {},
    fetcher,
  );
  return new Map(result.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]));
}

export function toBase64(data: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < data.length; i += step) {
    binary += String.fromCharCode(...data.subarray(i, i + step));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
