# Fotoscan

Alte Fotoalben mit dem Smartphone digitalisieren – als Web-App, die vollständig
auf dem Gerät läuft. Gedacht als Ersatz für Google PhotoScan, das nicht mehr
weiterentwickelt wird.

Kein Konto, kein Upload, keine Werbung: Die Fotos verlassen das Telefon erst,
wenn sie ausdrücklich exportiert oder geteilt werden.

## Was die App macht

- **Fotos automatisch finden.** Eine aufgeschlagene Albumseite wird als Ganzes
  fotografiert; die App erkennt die einzelnen Bilder darauf und schneidet jedes
  separat zu. Ein einzelnes Foto auf dem Tisch funktioniert genauso.
- **Perspektive korrigieren.** Schräg aufgenommene Bilder werden auf ein
  Rechteck entzerrt, inklusive Drehung.
- **Entspiegeln.** Beim Auslösen entstehen mehrere Aufnahmen. Weil eine
  Spiegelung beim Bewegen des Telefons über das Foto wandert, ist sie in jeder
  Aufnahme woanders und fällt beim Verrechnen als heller Ausreisser heraus.
- **Aufhellen.** Tonwerte spreizen, leicht nachschärfen und – abschaltbar – den
  Gelbstich vergilbter Abzüge abschwächen.
- **Alben verwalten.** Scans werden pro Album im Gerät gespeichert und lassen
  sich einzeln teilen oder als ZIP-Datei exportieren.
- **Offline.** Nach dem ersten Aufruf läuft die App als installierte PWA ohne
  Internetverbindung.

## Bedienung

1. Album anlegen (zum Beispiel „Ferien 1978“).
2. Auf **Scannen** tippen und die Albumseite formatfüllend ins Bild nehmen.
   Bei ruhiger Kameraführung löst die App von selbst aus.
3. Im Schritt **Zuschnitt prüfen** einzelne Fotos über das Häkchen abwählen,
   Ecken bei Bedarf nachziehen, drehen, speichern.
4. Über **Exportieren** wandert das ganze Album auf den Rechner oder in eine
   andere App.

Ohne Kamerazugriff – etwa am Rechner – lässt sich über **Galerie** ein
vorhandenes Bild öffnen und genauso verarbeiten.

### Für gute Ergebnisse

- Gleichmässiges, indirektes Licht; kein direkter Blitz.
- Das Album flach hinlegen und möglichst senkrecht darüber fotografieren.
- Entspiegeln eingeschaltet lassen und das Telefon beim Auslösen ein paar
  Zentimeter bewegen.

## Wie die Erkennung funktioniert

Die Bildverarbeitung ist vollständig eigener Code – keine OpenCV-Einbindung,
kein WASM-Download. Die Pipeline liegt in [`src/lib/imaging/`](src/lib/imaging):

| Schritt | Datei | Beschreibung |
| --- | --- | --- |
| Graustufen, Skalieren, Weichzeichnen | `gray.ts` | Analyse läuft auf 720 px Kantenlänge |
| Sobel, Schwellwert, Morphologie | `mask.ts` | stärkste 10 % der Gradienten, Lücken schliessen |
| Flächen bestimmen | `mask.ts` | vom Bildrand fluten; was übrig bleibt, ist von einer geschlossenen Kante umgeben |
| Viereck annähern | `geometry.ts` | konvexe Hülle, Douglas-Peucker auf genau vier Ecken |
| Entzerren | `warp.ts` | Homographie über ein 8×8-Gleichungssystem, bilineare Abtastung |
| Entspiegeln | `destack.ts` | Aufnahmen ausrichten, pro Pixel den mittleren Helligkeitswert nehmen |
| Aufhellen | `enhance.ts` | Tonwertspreizung über die Helligkeit, Grauwelt-Weissabgleich, Unschärfemaske |

Zwei Punkte, die den Unterschied machen:

- **Verschachtelte Suche.** Wird eine grosse Fläche gefunden, sucht die App
  darin weiter. Die Albumseite auf dem Tisch ist also nur die Zwischenstufe;
  ausgegeben werden die Fotos darauf. Dafür wird die gefundene Fläche entzerrt
  statt nur ausgeschnitten – so verschwindet der Seitenrand vollständig aus dem
  Suchbild, und auch Fotos direkt am Seitenrand bleiben getrennt erkennbar.
- **Kantensaum abziehen.** Weichzeichner und Sobel verbreitern jede Kante um
  einige Pixel. Ohne Korrektur läge ein heller Streifen Albumpapier mit im
  Zuschnitt, deshalb wird jedes Viereck um genau diese Saumbreite nach innen
  versetzt.

Die schweren Schritte laufen in einem Web Worker
([`src/worker/pipeline.worker.ts`](src/worker/pipeline.worker.ts)); scheitert
das, rechnet dieselbe Funktion auf dem Hauptthread weiter.

## Entwickeln

```bash
npm install
npm run dev        # Vite-Server, im Netz erreichbar (--host ist gesetzt)
npm test           # Modultests der Bildverarbeitung
npm run test:e2e   # Browsertest des gesamten Ablaufs
npm run build      # Symbole erzeugen, Typen prüfen, bauen
```

Die Kamera braucht einen sicheren Kontext. Zum Testen auf dem Telefon entweder
über HTTPS ausliefern oder den Rechner per USB-Weiterleitung als `localhost`
einbinden.

### Tests

- `tests/` prüft die Bildverarbeitung an synthetisch erzeugten Albumseiten:
  gedrehte und perspektivisch verzerrte Fotos, mehrere Fotos auf heller und auf
  dunkler Seite, Leserichtung, der Griff durch die Albumseite hindurch, das
  Entfernen wandernder Spiegelungen und der Zuschnitt ohne hellen Saum.
- `e2e/` fährt in Chromium den kompletten Weg ab: Album anlegen, Albumseite
  öffnen, drei erkannte Fotos, eines abwählen, speichern, Neustart überstehen.

## Veröffentlichen

Statische Dateien – jeder Webspace mit HTTPS genügt. Für GitHub Pages liegt ein
fertiger Arbeitsablauf bereit:

```bash
cp deploy.yml.example ../../.github/workflows/fotoscan.yml
```

Für eine Projektseite unter `https://<name>.github.io/<repo>/` muss beim Bauen
`VITE_BASE=/<repo>/` gesetzt sein; der Arbeitsablauf erledigt das.

## Lizenz

MIT
