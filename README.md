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
- **Entspiegeln über vier Punkte.** Nach dem Auslösen erscheinen vier Punkte –
  nicht auf dem Bildschirm, sondern auf dem Album selbst: Sie liegen dort, wo
  die App das Motiv sieht, und wandern mit ihm mit. Das Telefon wird
  nacheinander zu jedem geneigt, und an jedem Punkt entsteht eine Aufnahme.
  Weil eine Spiegelung mit dem Blickwinkel über das Foto wandert, sitzt sie in
  jeder der fünf Aufnahmen woanders und fällt beim Verrechnen als heller
  Ausreisser heraus. Verliert die Kamera das Album aus dem Blick, wird nicht
  ausgelöst – sonst entstünden vier Aufnahmen vom Tisch.
- **Nahaufnahmen für die Auflösung.** Auf der Seitenaufnahme teilen sich alle
  Fotos einer Seite die Bildpunkte der Kamera; für das einzelne Foto bleiben ein
  paar hundert. Wer will, geht danach jedes Foto einzeln noch einmal aus der
  Nähe an – das bringt ein Vielfaches an Auflösung. Die Spiegelung, die sich aus
  der Nähe unweigerlich einstellt, rechnet die Seitenaufnahme wieder heraus.
- **Aufhellen.** Tonwerte spreizen, leicht nachschärfen und – abschaltbar – den
  Gelbstich vergilbter Abzüge abschwächen.
- **Objektiv wählen.** Moderne Telefone haben mehrere Rückkameras, und der
  Browser greift von sich aus gern zum Ultraweitwinkel – das biegt gerade
  Fotokanten sichtbar krumm. Die App wählt darum selbst die Hauptkamera und
  lässt die Wahl über das Einstellungssymbol ändern; dazu Zoom und Fokus,
  soweit das Gerät sie hergibt. Die Wahl wird gemerkt.
- **Alben verwalten.** Scans werden pro Album im Gerät gespeichert und lassen
  sich einzeln teilen oder als ZIP-Datei exportieren.
- **Offline.** Nach dem ersten Aufruf läuft die App als installierte PWA ohne
  Internetverbindung.

## Bedienung

1. Album anlegen (zum Beispiel „Ferien 1978“).
2. Auf **Scannen** tippen und die Albumseite ins Bild nehmen, mit etwas Luft
   ringsum. Der Sucher sagt, woran es noch fehlt – nichts erkannt, ein Foto
   reicht bis an den Bildrand, Kamera noch unruhig. Erst wenn nichts mehr
   dagegen spricht, löst die App von selbst aus.
3. Die vier Punkte der Reihe nach anfahren: Telefon leicht nach oben, rechts,
   unten und links neigen – das Album dabei im Bild behalten. Jeder Punkt hakt
   sich ab, sobald der Ring darauf liegt. Blasst der Punktekranz ab, ist das
   Album aus dem Blick geraten; dann wird nichts aufgenommen, bis es wieder da
   ist. **Fertig** bricht früher ab und rechnet mit dem, was da ist.
4. Im Schritt **Zuschnitt prüfen** einzelne Fotos über das Häkchen abwählen,
   Ecken bei Bedarf nachziehen, drehen.
5. Wer es schärfer will: **Nahaufnahmen → Aufnehmen**. Die App geht die Fotos
   der Reihe nach durch; jedes wird formatfüllend aufgenommen, einzeln
   überspringbar. Danach zurück im Zuschnitt speichern.
6. Über **Exportieren** wandert das ganze Album auf den Rechner oder in eine
   andere App.

Ohne Kamerazugriff – etwa am Rechner – lässt sich über **Galerie** ein
vorhandenes Bild öffnen und genauso verarbeiten.

### Für gute Ergebnisse

- Gleichmässiges, indirektes Licht; kein direkter Blitz.
- Das Album flach hinlegen und möglichst senkrecht darüber fotografieren.
- Entspiegeln eingeschaltet lassen und die vier Punkte wirklich anfahren –
  je deutlicher der Blickwinkel wechselt, desto sauberer verschwindet die
  Spiegelung.

Ohne Lagesensor – am Rechner oder wenn iOS den Zugriff verweigert – nimmt die
App stattdessen fünf Aufnahmen im Takt auf und bittet darum, das Telefon dabei
zu bewegen.

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
| Motiv verfolgen | `track.ts` | Muster der Grundaufnahme über normierte Kreuzkorrelation wiederfinden |
| Aufnahmen zuordnen | `detect.ts`, `stack.ts` | jede Aufnahme einzeln erkennen und ihr Viereck der Grundaufnahme zuordnen |
| Entspiegeln | `destack.ts` | Aufnahmen ausrichten, pro Pixel den mittleren Helligkeitswert nehmen |
| Nahaufnahme verrechnen | `closeup.ts` | Seitenaufnahme auf die Nahaufnahme hochziehen, Glanzstellen daraus ersetzen |
| Aufhellen | `enhance.ts` | Tonwertspreizung über die Helligkeit, Grauwelt-Weissabgleich, Unschärfemaske |

Vier Punkte, die den Unterschied machen:

- **Verschachtelte Suche.** Wird eine grosse Fläche gefunden, sucht die App
  darin weiter. Die Albumseite auf dem Tisch ist also nur die Zwischenstufe;
  ausgegeben werden die Fotos darauf. Dafür wird die gefundene Fläche entzerrt
  statt nur ausgeschnitten – so verschwindet der Seitenrand vollständig aus dem
  Suchbild, und auch Fotos direkt am Seitenrand bleiben getrennt erkennbar.
- **Kantensaum abziehen.** Weichzeichner und Sobel verbreitern jede Kante um
  einige Pixel. Ohne Korrektur läge ein heller Streifen Albumpapier mit im
  Zuschnitt, deshalb wird jedes Viereck um genau diese Saumbreite nach innen
  versetzt.
- **Je Aufnahme neu erkennen.** Beim Abfahren der vier Punkte bewegt sich das
  Telefon absichtlich – dasselbe Foto liegt dann in jeder Aufnahme woanders und
  in einer anderen Perspektive. Alle Aufnahmen mit dem Viereck der ersten zu
  entzerren reicht nicht: Der Ausrichtungsschritt kann nur verschieben, nicht
  drehen. Deshalb wird jede Aufnahme einzeln erkannt und ihr Foto dem der
  Grundaufnahme zugeordnet. Bei kräftiger Bewegung halbiert das den Fehler
  gegenüber dem gemeinsamen Viereck; wird ein Foto in einer Aufnahme nicht
  sicher wiedergefunden, bleibt diese Aufnahme aussen vor.
- **Punkte am Motiv, nicht am Bildschirm.** Aus der Grundaufnahme wird der
  Bereich der erkannten Fotos als kleines Graumuster gemerkt und in jedem
  Vorschaubild über die normierte Kreuzkorrelation wiedergesucht – die ist
  unabhängig von Helligkeit und Kontrast, und der grobe Raster verzeiht den
  Perspektivwechsel, den das Neigen mit sich bringt. Das liefert zweierlei:
  die Stelle, an der die vier Punkte zu zeichnen sind, und die Antwort auf die
  Frage, ob überhaupt noch dasselbe Motiv vor der Kamera liegt. Ohne diese
  Antwort ist jede Neigung gleich viel wert – auch die, bei der das Telefon
  längst woandershin zeigt. Genau daran entstanden Aufnahmereihen vom Tisch.

- **Nur der Glanz wird ersetzt.** Bei der Nahaufnahme liefert die
  Seitenaufnahme allein die Stellen, an denen die Nahaufnahme glänzt – überall
  sonst bliebe sie hochgerechnet und weich. Gesucht wird deshalb, wo die
  Nahaufnahme deutlich heller ist als die Seitenaufnahme; der Rest bleibt
  unangetastet. Zwei Filter halten das sauber: Eine scharfe Aufnahme ist an
  ihren hellsten Punkten fast überall etwas heller als eine weiche, und ohne
  Filter zöge sich die Weichheit über hunderte Streusel ins ganze Bild. Es
  zählt daher nur, was zusammenhängt und einen Fleck bildet. Passen die beiden
  Aufnahmen nicht zueinander – falsches Foto erwischt –, verrät das ihr
  Zusammenhang, und die Nahaufnahme bleibt, wie sie ist.

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
  Entfernen wandernder Spiegelungen und der Zuschnitt ohne hellen Saum. Dazu
  eine Aufnahmereihe mit bewegter Kamera, die belegt, dass die Zuordnung je
  Aufnahme das Ergebnis messbar verbessert, sowie das Wiederfinden des Motivs
  über Verschiebung, Drehung, Grösse und Helligkeit hinweg – samt der Fälle, in
  denen es als verloren gelten muss. Für die Nahaufnahmen: dass der Glanz
  verschwindet, die Zeichnung bleibt, ausserhalb des Glanzes kein Bildpunkt
  angefasst wird und eine unpassende Vergleichsaufnahme folgenlos bleibt.
- `e2e/` fährt in Chromium zwei Wege ab. Ohne Kameraerlaubnis: Album anlegen,
  Albumseite über „Galerie" öffnen, drei erkannte Fotos, eines abwählen,
  speichern, Neustart überstehen. Mit künstlichem Kamerabild: auslösen, die
  vier Punkte über nachgestellte Neigungswerte anfahren, das gerechnete Foto
  speichern – und der Rückfall auf die Zeitsteuerung, wenn kein Lagesensor
  antwortet. Dazu die Runde der Nahaufnahmen: der Reihe nach durchgehen,
  überspringen, abbrechen.

## Veröffentlichen

Die App besteht aus statischen Dateien – jeder Webspace mit HTTPS genügt. Die
Kamera arbeitet nur in einem sicheren Kontext, also über HTTPS oder auf
`localhost`.

`.github/workflows/deploy.yml` erledigt das für GitHub Pages: Bei jedem Push
auf `main` laufen erst die Modultests, dann der Bau mit `VITE_BASE=/<repo>/`,
dann die Veröffentlichung. Schlagen die Tests fehl, bleibt die zuletzt
veröffentlichte Fassung stehen. Pages schaltet sich beim ersten Lauf selbst
ein.

Ergebnis: `https://<name>.github.io/<repo>/`

Für eine eigene Domain den Namen in `public/CNAME` legen und in den
Repository-Einstellungen eintragen; dann liegt die App an der Wurzel und
`VITE_BASE` kann entfallen.

## Lizenz

MIT
