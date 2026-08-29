import { describe, expect, it } from 'vitest';
import { buildBook, encodeText } from '../src/lib/pdf';

/** Ein winziges, gültiges JPEG-Gerüst – der Inhalt spielt hier keine Rolle. */
function jpeg(marker: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, marker, 0x2a, 0x2a, 0xff, 0xd9]);
}

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function asText(data: Uint8Array): string {
  return Array.from(data, (byte) => String.fromCharCode(byte)).join('');
}

/** Enthält der Datenstrom diese Bytefolge? */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let k = 0; k < needle.length; k++) if (haystack[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

describe('Fotobuch', () => {
  it('schreibt ein PDF mit Deckblatt und einer Seite je Foto', async () => {
    const blob = buildBook({
      title: 'Ferien 1978',
      subtitle: '12.08.2026',
      photos: [
        { data: jpeg(1), width: 800, height: 600, title: 'Am See' },
        { data: jpeg(2), width: 600, height: 800, taken: 'Sommer 1978' },
      ],
    });

    const data = await bytes(blob);
    const text = asText(data);

    expect(blob.type).toBe('application/pdf');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);

    // Deckblatt plus zwei Fotoseiten.
    expect(text).toContain('/Count 3');
    expect(text).toContain('Ferien 1978');
    expect(text).toContain('Am See');
    expect(text).toContain('Sommer 1978');
  });

  it('übernimmt die JPEG-Daten unverändert, statt sie neu zu rechnen', async () => {
    const first = jpeg(7);
    const data = await bytes(buildBook({ title: 'Test', photos: [{ data: first, width: 100, height: 50 }] }));

    expect(contains(data, first)).toBe(true);
    expect(asText(data)).toContain('/Filter /DCTDecode');
    expect(asText(data)).toContain('/Width 100 /Height 50');
  });

  it('setzt die Querverweise auf die tatsächlichen Stellen der Objekte', async () => {
    // Ohne stimmende xref-Tabelle öffnet kein Betrachter die Datei; und weil
    // ein Foto beliebige Bytes mitbringt, dürfen die Stellen nicht über die
    // Zeichenlänge, sondern nur über die Bytelänge berechnet werden.
    const data = await bytes(
      buildBook({
        title: 'Zähltest – äöü',
        photos: [
          { data: jpeg(3), width: 400, height: 300, note: 'Mit Umlauten: Grüsse aus Zürich' },
          { data: jpeg(4), width: 400, height: 300 },
        ],
      }),
    );
    const text = asText(data);

    const startxref = Number(/startxref\s+(\d+)/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    const table = text.slice(startxref).split('\n');
    const count = Number(/0 (\d+)/.exec(table[1])?.[1]);
    expect(count).toBeGreaterThan(5);

    // Nach „xref" und der Zeile mit der Anzahl steht der freie Eintrag 0;
    // jeder Eintrag danach muss auf „<n> 0 obj" zeigen.
    for (let id = 1; id < count; id++) {
      const offset = Number(table[2 + id].slice(0, 10));
      expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
    }
  });

  it('stellt die Übersichtsaufnahme vor die Fotos einer Seite', async () => {
    const sheet = jpeg(9);
    const data = await bytes(
      buildBook({
        title: 'Mit Seiten',
        photos: [
          { data: jpeg(1), width: 400, height: 300 },
          { data: jpeg(2), width: 400, height: 300 },
        ],
        pages: [{ data: sheet, width: 800, height: 600, label: 'Albumseite 1' }, null],
      }),
    );
    const text = asText(data);

    // Deckblatt, Übersichtsaufnahme, zwei Fotos.
    expect(text).toContain('/Count 4');
    expect(text).toContain('Albumseite 1');
    expect(contains(data, sheet)).toBe(true);
  });

  it('schreibt Umlaute als WinAnsi und ersetzt Unbekanntes', () => {
    expect(Array.from(encodeText('äöü'))).toEqual([0xe4, 0xf6, 0xfc]);
    // Der Gedankenstrich hat in WinAnsi eine eigene Stelle …
    expect(Array.from(encodeText('–'))).toEqual([0x96]);
    // … ein Emoji nicht; dafür steht ein Fragezeichen statt eines kaputten Zeichens.
    expect(Array.from(encodeText('☺')).every((byte) => byte === 63)).toBe(true);
  });
});
