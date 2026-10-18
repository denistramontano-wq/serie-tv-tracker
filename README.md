# Visti · Serie e Podcast

PWA per telefono per cercare serie TV e podcast e tenere traccia di cosa hai visto/ascoltato e di cosa ti manca.

## Funzioni
- **Cerca** serie TV (dati TVmaze) e podcast (dati Apple Podcasts), senza account e senza chiavi API.
- **Libreria** divisa in *In corso*, *Da iniziare*, *Finiti*, con filtro Serie/Podcast.
- Per ogni titolo: episodi per stagione, spunta singola, spunta di stagione, "fino a qui" (segna anche tutti i precedenti), "segna tutto".
- Dalla libreria: prossimo episodio da vedere e spunta veloce.
- Episodi nuovi controllati in automatico all'apertura; avvisa delle prossime uscite.
- Statistiche (episodi e ore totali), backup/ripristino in JSON.
- Funziona offline con gli episodi già salvati. Dati salvati solo sul telefono.

## Pubblicazione
È un sito statico: basta servire la cartella via HTTPS. Con GitHub Pages:
Settings → Pages → Source: *Deploy from a branch* → scegli il branch e la cartella `/ (root)`.
Poi apri l'indirizzo dal telefono e usa "Installa app" (Android) o "Aggiungi alla schermata Home" (iPhone).
