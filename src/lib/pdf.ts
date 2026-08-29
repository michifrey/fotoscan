/**
 * Ein kleiner PDF-Schreiber für das Fotobuch.
 *
 * Warum von Hand statt einer Bibliothek: Die Fotos liegen bereits als JPEG vor,
 * und genau so wandern sie ins PDF – ein JPEG ist im PDF ein gültiger
 * Bilddatenstrom (`DCTDecode`). Es wird also nichts neu berechnet und nichts
 * neu komprimiert; das fertige Buch enthält dieselben Bildpunkte wie das Album,
 * und der ganze Schreiber bleibt in einer Datei lesbar.
 */

export interface BookPhoto {
  /** JPEG-Daten, unverändert übernommen. */
  data: Uint8Array;
  width: number;
  height: number;
  title?: string;
  taken?: string;
  note?: string;
}

export interface BookPage {
  /** Übersichtsaufnahme der Albumseite, ebenfalls JPEG. */
  data: Uint8Array;
  width: number;
  height: number;
  label: string;
}

export interface BookOptions {
  title: string;
  subtitle?: string;
  photos: BookPhoto[];
  /** Übersichtsaufnahmen, die vor den Fotos einer Seite stehen. */
  pages?: (BookPage | null)[];
}

/** A4 in Punkten (72 dpi), das übliche Mass für ein gedrucktes Buch. */
const WIDTH = 595;
const HEIGHT = 842;
const MARGIN = 40;
/** Platz unter dem Bild für Titel, Datum und Notiz. */
const CAPTION = 74;

type Obj = { id: number; body: Uint8Array };

export function buildBook({ title, subtitle, photos, pages = [] }: BookOptions): Blob {
  const objects: Obj[] = [];
  let next = 1;
  const add = (body: string | Uint8Array): number => {
    const id = next++;
    objects.push({ id, body: typeof body === 'string' ? encodeText(body) : body });
    return id;
  };

  const catalog = next++;
  const pageTree = next++;
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const pageIds: number[] = [];
  const sheet = (content: string, images: { name: string; id: number }[]): void => {
    const stream = add(streamObject(`<< /Length ${byteLength(content)} >>`, encodeText(content)));
    const resources =
      `<< /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> /XObject << ` +
      images.map((image) => `/${image.name} ${image.id} 0 R`).join(' ') +
      ' >> >>';
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] ` +
          `/Resources ${resources} /Contents ${stream} 0 R >>`,
      ),
    );
  };

  // Deckblatt.
  sheet(cover(title, subtitle, photos.length), []);

  photos.forEach((photo, index) => {
    const page = pages[index];
    if (page) {
      const id = add(imageObject(page.data, page.width, page.height));
      sheet(picture('Im0', page, [], page.label, true), [{ name: 'Im0', id }]);
    }
    const id = add(imageObject(photo.data, photo.width, photo.height));
    sheet(
      picture('Im0', photo, [photo.title, photo.taken, photo.note].filter(Boolean) as string[], undefined, false),
      [{ name: 'Im0', id }],
    );
  });

  objects.push({
    id: pageTree,
    body: encodeText(
      `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
    ),
  });
  objects.push({ id: catalog, body: encodeText(`<< /Type /Catalog /Pages ${pageTree} 0 R >>`) });

  return assemble(objects, catalog);
}

/** Der Inhalt einer Bildseite: das Bild eingepasst, darunter die Beschriftung. */
function picture(
  name: string,
  image: { width: number; height: number },
  lines: string[],
  heading: string | undefined,
  faint: boolean,
): string {
  const top = heading ? HEIGHT - MARGIN - 26 : HEIGHT - MARGIN;
  const bottom = MARGIN + (lines.length > 0 ? CAPTION : 0);
  const room = { width: WIDTH - 2 * MARGIN, height: top - bottom };
  const factor = Math.min(room.width / image.width, room.height / image.height);
  const drawn = { width: image.width * factor, height: image.height * factor };
  const x = (WIDTH - drawn.width) / 2;
  const y = bottom + (room.height - drawn.height) / 2;

  const parts: string[] = [];
  if (heading) {
    parts.push(text(heading, MARGIN, HEIGHT - MARGIN - 12, 11, faint ? 0.45 : 0.25, false));
  }
  parts.push(`q ${round(drawn.width)} 0 0 ${round(drawn.height)} ${round(x)} ${round(y)} cm /${name} Do Q`);

  // Die Beschriftung steht unter dem Bild, nicht am Fuss der Seite: Sie gehört
  // zum Foto, und ein Streifen Weiss dazwischen trennt sie davon ab.
  let line = y - 18;
  lines.forEach((value, index) => {
    parts.push(text(value, MARGIN, line, index === 0 ? 12 : 10, index === 0 ? 0.15 : 0.45, index === 0));
    line -= index === 0 ? 16 : 13;
  });
  return parts.join('\n');
}

function cover(title: string, subtitle: string | undefined, count: number): string {
  const parts = [
    text(title, MARGIN, HEIGHT * 0.55, 30, 0.1, true),
    text(subtitle ?? '', MARGIN, HEIGHT * 0.55 - 30, 13, 0.4, false),
    text(`${count} ${count === 1 ? 'Foto' : 'Fotos'}`, MARGIN, MARGIN + 12, 10, 0.55, false),
  ];
  // Ein Strich unter dem Titel, damit das Deckblatt nicht nackt wirkt.
  parts.push(`0.75 w 0.6 G ${MARGIN} ${round(HEIGHT * 0.55 - 12)} m ${WIDTH - MARGIN} ${round(HEIGHT * 0.55 - 12)} l S`);
  return parts.join('\n');
}

function text(value: string, x: number, y: number, size: number, gray: number, boldFace: boolean): string {
  if (!value) return '';
  return `BT /${boldFace ? 'F2' : 'F1'} ${size} Tf ${round(gray)} g ${round(x)} ${round(y)} Td (${escapeText(value)}) Tj ET`;
}

function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/** Ein JPEG wird unverändert zum Bildobjekt – das ist der Sinn von DCTDecode. */
function imageObject(data: Uint8Array, width: number, height: number): Uint8Array {
  const header =
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>`;
  return streamObject(header, data);
}

function streamObject(header: string, data: Uint8Array): Uint8Array {
  const before = encodeText(`${header}\nstream\n`);
  const after = encodeText('\nendstream');
  const out = new Uint8Array(before.length + data.length + after.length);
  out.set(before, 0);
  out.set(data, before.length);
  out.set(after, before.length + data.length);
  return out;
}

/** Objekte hintereinanderlegen und die Querverweistabelle dazu schreiben. */
function assemble(objects: Obj[], catalog: number): Blob {
  const sorted = objects.slice().sort((a, b) => a.id - b.id);
  const parts: Uint8Array[] = [encodeText('%PDF-1.4\n')];
  const offsets = new Map<number, number>();
  let position = parts[0].length;

  for (const object of sorted) {
    const head = encodeText(`${object.id} 0 obj\n`);
    const tail = encodeText('\nendobj\n');
    offsets.set(object.id, position);
    parts.push(head, object.body, tail);
    position += head.length + object.body.length + tail.length;
  }

  const count = sorted.length + 1;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) {
    table += `${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  table += `trailer\n<< /Size ${count} /Root ${catalog} 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  parts.push(encodeText(table));

  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}

function byteLength(value: string): number {
  return encodeText(value).length;
}

/**
 * Text nach WinAnsi. Umlaute und Anführungszeichen kommen in deutschen
 * Bildunterschriften ständig vor; alles, was die Tabelle nicht kennt, wird zu
 * einem Fragezeichen statt zu einem kaputten Zeichen.
 */
const SPECIAL: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85,
  '‰': 0x89,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
};

export function encodeText(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i) ?? 63;
    if (code < 256) out[i] = code;
    else out[i] = SPECIAL[value[i]] ?? 63;
  }
  return out;
}

function escapeText(value: string): string {
  return value.replace(/[\\()]/g, (match) => `\\${match}`).replace(/[\r\n]+/g, ' ');
}
