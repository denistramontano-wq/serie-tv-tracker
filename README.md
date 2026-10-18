# Serie e Podcast

PWA per tenere traccia di serie TV e podcast: a che punto sei, quante puntate ci sono, quante ne mancano.

- Serie: API TVmaze. Podcast: iTunes Search/Lookup API. Nessuna chiave.
- Dati solo sul telefono (`localStorage`, chiave `tracker_serie_podcast_v1`).
- Service worker con cache dell'app shell: si apre anche offline.

## Pubblicazione
GitHub Pages: Settings → Pages → Deploy from a branch → `main`, cartella `/ (root)`.
Poi dal telefono: Android "Installa app", iPhone Condividi → "Aggiungi alla schermata Home".

Ad ogni nuova versione aggiornare anche `CACHE` in `sw.js`.
