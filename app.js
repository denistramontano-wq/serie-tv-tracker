'use strict';

/* Visti · Serie e Podcast
 * Serie TV: API TVmaze (gratuita, senza chiave).
 * Podcast: iTunes Search API (gratuita, senza chiave, via JSONP).
 * Tutti i dati restano nel telefono (localStorage). */

const APP_VERSION = 'v1.0';
const STORE_KEY = 'visti.v1';
const STALE_MS = 6 * 60 * 60 * 1000; // ricarica gli episodi se più vecchi di 6 ore
const POD_PAGE = 40;

/* ---------- Stato e salvataggio ---------- */

let db = load();
const preview = new Map(); // elementi visti in ricerca ma non (ancora) in libreria
const ui = { libStatus: 'watching', libType: 'all', searchType: 'tv', query: '', results: null, podShown: POD_PAGE };

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && d.items) return d;
  } catch (e) { /* dati corrotti o storage non disponibile */ }
  return { items: {} };
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch (e) {
    toast('Impossibile salvare: memoria piena?');
  }
}

/* ---------- Utilità ---------- */

const $ = (sel, root = document) => root.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stripHtml(html) {
  if (!html) return '';
  return new DOMParser().parseFromString(html, 'text/html').body.textContent.trim();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(d) {
  if (!d) return 'data da annunciare';
  const [y, m, g] = d.slice(0, 10).split('-');
  return `${g}/${m}/${y}`;
}

function epCode(ep) {
  if (ep.s == null) return '';
  return `S${String(ep.s).padStart(2, '0')}E${ep.n == null ? '?' : String(ep.n).padStart(2, '0')}`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function jsonp(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const cb = 'jp' + Date.now() + Math.floor(Math.random() * 1e6);
    const s = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout);
    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      s.remove();
    }
    window[cb] = (data) => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error('rete')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(s);
  });
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ---------- Sorgenti dati ---------- */

const api = {
  async searchTv(q) {
    const res = await getJson('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(q));
    return res.map(({ show }) => tvInfo(show));
  },

  async loadTv(tvId) {
    const show = await getJson(`https://api.tvmaze.com/shows/${tvId}?embed=episodes`);
    const eps = (show._embedded?.episodes || []).map((e) => ({
      id: e.id, s: e.season, n: e.number, t: e.name, d: e.airdate || '', r: e.runtime || null
    }));
    return { info: tvInfo(show), eps };
  },

  async searchPod(q) {
    const res = await jsonp('https://itunes.apple.com/search?media=podcast&entity=podcast&country=IT&limit=30&term=' + encodeURIComponent(q));
    return (res.results || []).map(podInfo);
  },

  async loadPod(podId) {
    const res = await jsonp(`https://itunes.apple.com/lookup?id=${podId}&entity=podcastEpisode&country=IT&limit=200`);
    const all = res.results || [];
    const head = all.find((r) => r.wrapperType === 'track' && r.kind === 'podcast') || all[0];
    const eps = all
      .filter((r) => r.wrapperType === 'podcastEpisode' || r.kind === 'podcast-episode')
      .map((e) => ({
        id: e.trackId, s: null, n: null, t: e.trackName,
        d: (e.releaseDate || '').slice(0, 10),
        r: e.trackTimeMillis ? Math.round(e.trackTimeMillis / 60000) : null
      }))
      .sort((a, b) => b.d.localeCompare(a.d));
    return { info: head ? podInfo(head) : null, eps };
  }
};

function tvInfo(show) {
  return {
    key: 'tv:' + show.id,
    type: 'tv',
    extId: show.id,
    title: show.name,
    image: show.image?.medium || show.image?.original || '',
    year: (show.premiered || '').slice(0, 4),
    by: show.network?.name || show.webChannel?.name || '',
    state: show.status === 'Ended' ? 'Conclusa' : show.status === 'Running' ? 'In corso' : (show.status || ''),
    summary: stripHtml(show.summary),
    genres: show.genres || []
  };
}

function podInfo(p) {
  return {
    key: 'pod:' + p.collectionId,
    type: 'pod',
    extId: p.collectionId,
    title: p.collectionName,
    image: p.artworkUrl600 || p.artworkUrl100 || '',
    year: '',
    by: p.artistName || '',
    state: p.trackCount ? `${p.trackCount} episodi` : '',
    summary: '',
    genres: (p.genres || []).filter((g) => g !== 'Podcasts' && g !== 'Podcast')
  };
}

/* ---------- Logica di avanzamento ---------- */

function getItem(key) {
  return db.items[key] || preview.get(key) || null;
}

function inLibrary(key) {
  return Boolean(db.items[key]);
}

function isAired(ep) {
  return Boolean(ep.d) && ep.d <= today();
}

// Ordine "da guardare": serie dal primo episodio, podcast dal più recente.
function orderedEps(item) {
  const eps = (item.eps || []).filter(isAired);
  if (item.type === 'tv') {
    return eps.slice().sort((a, b) => (a.s - b.s) || ((a.n ?? 1e9) - (b.n ?? 1e9)) || a.d.localeCompare(b.d));
  }
  return eps.slice().sort((a, b) => b.d.localeCompare(a.d));
}

function progress(item) {
  const aired = (item.eps || []).filter(isAired);
  const seen = aired.filter((e) => item.watched?.[e.id]).length;
  const total = aired.length;
  let status = 'todo';
  if (seen > 0) status = seen >= total ? 'done' : 'watching';
  const next = orderedEps(item).find((e) => !item.watched?.[e.id]) || null;
  const upcoming = (item.eps || []).filter((e) => !isAired(e) && e.d).sort((a, b) => a.d.localeCompare(b.d))[0] || null;
  return { seen, total, status, next, upcoming, pct: total ? Math.round((seen / total) * 100) : 0 };
}

function addToLibrary(item) {
  if (inLibrary(item.key)) return db.items[item.key];
  const it = { ...item, watched: item.watched || {}, addedAt: Date.now(), touchedAt: Date.now() };
  db.items[it.key] = it;
  preview.delete(it.key);
  save();
  toast(`Aggiunto: ${it.title}`);
  return it;
}

function removeFromLibrary(key) {
  const it = db.items[key];
  if (!it) return;
  delete db.items[key];
  preview.set(key, { ...it, watched: {} });
  save();
  toast(`Rimosso: ${it.title}`);
}

// Segna o toglie un insieme di episodi; aggiunge alla libreria se serve.
function setWatched(key, ids, value) {
  let it = getItem(key);
  if (!it) return;
  if (!inLibrary(key)) it = addToLibrary(it);
  it.watched = it.watched || {};
  for (const id of ids) {
    if (value) it.watched[id] = Date.now();
    else delete it.watched[id];
  }
  it.touchedAt = Date.now();
  save();
}

async function refreshItem(key, force = false) {
  let it = getItem(key);
  if (!it) return null;
  if (!force && it.eps && it.fetchedAt && Date.now() - it.fetchedAt < STALE_MS) return it;
  const data = it.type === 'tv' ? await api.loadTv(it.extId) : await api.loadPod(it.extId);
  // Nel frattempo l'elemento può essere stato aggiunto alla libreria (copia nuova).
  it = getItem(key) || it;
  if (data.info) {
    // Mantiene descrizioni già note se la nuova risposta non le ha.
    for (const k of Object.keys(data.info)) {
      if (data.info[k] || !it[k]) it[k] = data.info[k];
    }
  }
  it.eps = data.eps;
  it.fetchedAt = Date.now();
  if (inLibrary(key)) save();
  return it;
}

let refreshingAll = false;
async function refreshAll(force = false) {
  if (refreshingAll) return 0;
  refreshingAll = true;
  let n = 0;
  try {
    for (const key of Object.keys(db.items)) {
      try {
        const before = (db.items[key].eps || []).length;
        await refreshItem(key, force);
        if ((db.items[key]?.eps || []).length !== before) n++;
      } catch (e) { /* offline o API non raggiungibile: si riprova più tardi */ }
    }
  } finally {
    refreshingAll = false;
  }
  return n;
}

/* ---------- Router ---------- */

function route() {
  const hash = location.hash || '#/library';
  const [, page, ...rest] = hash.split('/');
  const param = decodeURIComponent(rest.join('/'));
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === page));
  $('#backBtn').hidden = page !== 'item';
  window.scrollTo(0, 0);
  if (page === 'search') return renderSearch();
  if (page === 'settings') return renderSettings();
  if (page === 'item' && param) return renderItem(param);
  return renderLibrary();
}

function setTitle(t) {
  $('#title').textContent = t;
  document.title = t === 'Libreria' ? 'Visti · Serie e Podcast' : `${t} · Visti`;
}

/* ---------- Pagina: Libreria ---------- */

const STATUS_LABEL = { watching: 'In corso', todo: 'Da iniziare', done: 'Finiti' };

function renderLibrary() {
  setTitle('Libreria');
  const view = $('#view');
  const all = Object.values(db.items).map((it) => ({ it, p: progress(it) }));
  const byType = all.filter(({ it }) => ui.libType === 'all' || it.type === ui.libType);
  const counts = { watching: 0, todo: 0, done: 0 };
  byType.forEach(({ p }) => counts[p.status]++);
  const shown = byType
    .filter(({ p }) => p.status === ui.libStatus)
    .sort((a, b) => (b.it.touchedAt || 0) - (a.it.touchedAt || 0));

  view.innerHTML = `
    <div class="seg" role="tablist">
      ${['watching', 'todo', 'done'].map((s) => `
        <button data-status="${s}" class="${ui.libStatus === s ? 'on' : ''}">${STATUS_LABEL[s]}<span class="n">${counts[s]}</span></button>`).join('')}
    </div>
    <div class="chips">
      ${[['all', 'Tutti'], ['tv', 'Serie TV'], ['pod', 'Podcast']].map(([v, l]) => `
        <button class="chip ${ui.libType === v ? 'on' : ''}" data-type="${v}">${l}</button>`).join('')}
    </div>
    <div class="list">
      ${shown.length ? shown.map(({ it, p }) => libraryCard(it, p)).join('') : libraryEmpty(all.length)}
    </div>`;

  view.querySelectorAll('[data-status]').forEach((b) => b.onclick = () => { ui.libStatus = b.dataset.status; renderLibrary(); });
  view.querySelectorAll('[data-type]').forEach((b) => b.onclick = () => { ui.libType = b.dataset.type; renderLibrary(); });
  view.querySelectorAll('[data-quick]').forEach((b) => b.onclick = (e) => {
    e.preventDefault();
    const [key, id] = [b.dataset.quick, Number(b.dataset.ep)];
    setWatched(key, [id], true);
    toast(db.items[key].type === 'tv' ? 'Episodio visto ✓' : 'Episodio ascoltato ✓');
    renderLibrary();
  });
}

function libraryEmpty(total) {
  if (!total) {
    return `<div class="empty"><div class="big">📺</div>La libreria è vuota.<br><br>
      <a class="btn primary" href="#/search" style="text-decoration:none">Cerca una serie o un podcast</a></div>`;
  }
  return `<div class="empty">Niente in “${STATUS_LABEL[ui.libStatus]}”.</div>`;
}

function poster(it, cls = '') {
  const sq = it.type === 'pod' ? ' sq' : '';
  return it.image
    ? `<img class="poster${sq} ${cls}" src="${esc(it.image)}" alt="" loading="lazy">`
    : `<div class="poster${sq} ${cls}"></div>`;
}

function typeBadge(it) {
  return it.type === 'tv' ? '<span class="badge tv">Serie</span>' : '<span class="badge pod">Podcast</span>';
}

function libraryCard(it, p) {
  let next = '';
  if (p.next) {
    const lbl = it.type === 'tv' ? 'Prossimo' : 'Da ascoltare';
    next = `<div class="next"><b>${lbl}:</b> ${esc(epCode(p.next))} ${esc(p.next.t)}</div>`;
  } else if (p.upcoming) {
    next = `<div class="next">Nuovo episodio il ${fmtDate(p.upcoming.d)}</div>`;
  } else if (!it.eps) {
    next = '<div class="next">Episodi in caricamento…</div>';
  }
  const quick = p.next
    ? `<button class="check" data-quick="${esc(it.key)}" data-ep="${p.next.id}" aria-label="Segna come ${it.type === 'tv' ? 'visto' : 'ascoltato'}">✓</button>`
    : '';
  return `
    <a class="card" href="#/item/${encodeURIComponent(it.key)}">
      ${poster(it)}
      <div class="body">
        <div class="t">${esc(it.title)}</div>
        <div class="m">${typeBadge(it)}${p.seen}/${p.total} ${it.type === 'tv' ? 'visti' : 'ascoltati'}</div>
        ${next}
        <div class="bar ${p.status === 'done' ? 'done' : ''}"><i style="width:${p.pct}%"></i></div>
      </div>
      ${quick ? `<div class="side">${quick}</div>` : ''}
    </a>`;
}

/* ---------- Pagina: Cerca ---------- */

let searchSeq = 0;

function renderSearch() {
  setTitle('Cerca');
  const view = $('#view');
  view.innerHTML = `
    <div class="seg">
      <button data-st="tv" class="${ui.searchType === 'tv' ? 'on' : ''}">Serie TV</button>
      <button data-st="pod" class="${ui.searchType === 'pod' ? 'on' : ''}">Podcast</button>
    </div>
    <form class="search" id="searchForm">
      <input id="q" type="search" enterkeyhint="search" autocomplete="off"
        placeholder="${ui.searchType === 'tv' ? 'Es. Breaking Bad, Mare fuori…' : 'Es. Muschio Selvaggio, Il Post…'}"
        value="${esc(ui.query)}">
      <button class="btn primary" type="submit">Cerca</button>
    </form>
    <div id="results" class="list"></div>`;

  view.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => {
    if (ui.searchType === b.dataset.st) return;
    ui.searchType = b.dataset.st;
    ui.results = null;
    renderSearch();
    if (ui.query) doSearch();
  });
  $('#searchForm').onsubmit = (e) => {
    e.preventDefault();
    ui.query = $('#q').value.trim();
    $('#q').blur();
    doSearch();
  };
  if (ui.results) renderResults();
  else if (!ui.query) $('#q').focus();
}

async function doSearch() {
  const box = $('#results');
  if (!ui.query) { box.innerHTML = ''; return; }
  const seq = ++searchSeq;
  box.innerHTML = '<div class="spinner"></div>';
  try {
    const res = ui.searchType === 'tv' ? await api.searchTv(ui.query) : await api.searchPod(ui.query);
    if (seq !== searchSeq) return;
    ui.results = res;
    res.forEach((r) => { if (!inLibrary(r.key) && !preview.has(r.key)) preview.set(r.key, r); });
    renderResults();
  } catch (e) {
    if (seq !== searchSeq) return;
    box.innerHTML = '<div class="empty">Ricerca non riuscita. Controlla la connessione e riprova.</div>';
  }
}

function renderResults() {
  const box = $('#results');
  if (!box) return;
  const res = ui.results || [];
  if (!res.length) { box.innerHTML = '<div class="empty">Nessun risultato.</div>'; return; }
  box.innerHTML = res.map((r) => {
    const owned = inLibrary(r.key);
    const meta = [r.year, r.by, r.state].filter(Boolean).join(' · ');
    return `
      <a class="card" href="#/item/${encodeURIComponent(r.key)}">
        ${poster(r)}
        <div class="body">
          <div class="t">${esc(r.title)}</div>
          <div class="m">${esc(meta)}</div>
          ${r.genres.length ? `<div class="m">${esc(r.genres.slice(0, 3).join(', '))}</div>` : ''}
        </div>
        <div class="side">
          ${owned ? '<span class="badge">In libreria</span>' : `<button class="btn primary small" data-add="${esc(r.key)}">+ Aggiungi</button>`}
        </div>
      </a>`;
  }).join('');
  box.querySelectorAll('[data-add]').forEach((b) => b.onclick = (e) => {
    e.preventDefault();
    const it = addToLibrary(getItem(b.dataset.add));
    renderResults();
    refreshItem(it.key, true).catch(() => {});
  });
}

/* ---------- Pagina: Dettaglio ---------- */

async function renderItem(key) {
  const view = $('#view');
  let it = getItem(key);
  if (!it) {
    // Link diretto a un elemento non in memoria: ricostruisce dai dati remoti.
    const [type, extId] = key.split(':');
    if (!['tv', 'pod'].includes(type) || !extId) return renderLibrary();
    it = { key, type, extId: Number(extId), title: '', image: '', genres: [] };
    preview.set(key, it);
  }
  setTitle(it.title || 'Dettaglio');
  ui.podShown = POD_PAGE;
  drawItem(it);

  const needsLoad = !it.eps || !it.fetchedAt || Date.now() - it.fetchedAt > STALE_MS;
  if (needsLoad) {
    try {
      await refreshItem(key, true);
      if (location.hash === '#/item/' + encodeURIComponent(key)) {
        setTitle(getItem(key).title);
        drawItem(getItem(key));
      }
    } catch (e) {
      if (location.hash !== '#/item/' + encodeURIComponent(key)) return;
      if (!getItem(key).eps) {
        $('#eps').innerHTML = '<div class="empty">Impossibile caricare gli episodi. Controlla la connessione.</div>';
      } else {
        toast('Offline: mostro gli episodi salvati');
      }
    }
  }
}

function drawItem(it) {
  const view = $('#view');
  const owned = inLibrary(it.key);
  const p = progress(it);
  const word = it.type === 'tv' ? 'visti' : 'ascoltati';
  const meta = [it.year, it.by, it.state].filter(Boolean).join(' · ');

  view.innerHTML = `
    <div class="hero">
      ${poster(it)}
      <div>
        <h2>${esc(it.title)}</h2>
        <div class="m">${typeBadge(it)}${esc(meta)}</div>
        ${it.genres?.length ? `<div class="m">${esc(it.genres.join(', '))}</div>` : ''}
        ${it.eps ? `<div class="m" style="margin-top:6px"><b style="color:var(--text)">${p.seen}/${p.total}</b> ${word} · ${p.pct}%</div>
        <div class="bar ${p.status === 'done' ? 'done' : ''}"><i style="width:${p.pct}%"></i></div>` : ''}
      </div>
    </div>
    ${it.summary ? `<p class="summary clamp" id="summary">${esc(it.summary)}</p>` : ''}
    <div class="actions">
      ${owned
        ? `<button class="btn" id="allBtn">${p.status === 'done' ? 'Azzera progressi' : 'Segna tutto ' + (it.type === 'tv' ? 'visto' : 'ascoltato')}</button>
           <button class="btn danger" id="removeBtn">Rimuovi</button>`
        : '<button class="btn primary" id="addBtn">+ Aggiungi alla libreria</button>'}
    </div>
    <div id="eps">${it.eps ? '' : '<div class="spinner"></div>'}</div>`;

  const sum = $('#summary');
  if (sum) sum.onclick = () => sum.classList.toggle('clamp');

  const addBtn = $('#addBtn');
  if (addBtn) addBtn.onclick = () => { addToLibrary(it); drawItem(db.items[it.key]); };

  const removeBtn = $('#removeBtn');
  if (removeBtn) removeBtn.onclick = () => {
    if (!confirm(`Rimuovere “${it.title}” e i suoi progressi?`)) return;
    removeFromLibrary(it.key);
    location.hash = '#/library';
  };

  const allBtn = $('#allBtn');
  if (allBtn) allBtn.onclick = () => {
    const ids = (it.eps || []).filter(isAired).map((e) => e.id);
    if (p.status === 'done') {
      if (!confirm('Azzerare tutti i progressi?')) return;
      setWatched(it.key, ids, false);
    } else {
      setWatched(it.key, ids, true);
    }
    drawItem(getItem(it.key));
  };

  if (it.eps) drawEpisodes(it);
}

function epRow(it, ep) {
  const on = Boolean(it.watched?.[ep.id]);
  const aired = isAired(ep);
  const meta = [fmtDate(ep.d), ep.r ? ep.r + ' min' : ''].filter(Boolean).join(' · ');
  const code = epCode(ep);
  return `
    <div class="ep ${aired ? '' : 'future'}">
      <button class="check ${on ? 'on' : ''}" data-ep="${ep.id}" ${aired ? '' : 'disabled'}
        aria-pressed="${on}" aria-label="${esc(code + ' ' + ep.t)}">✓</button>
      <div class="body">
        <div class="t">${code ? `<b>${esc(code)}</b> · ` : ''}${esc(ep.t)}</div>
        <div class="m">${aired ? esc(meta) : 'In uscita: ' + esc(fmtDate(ep.d))}</div>
      </div>
      ${aired && !on ? `<button class="upto" data-upto="${ep.id}" title="Segna anche tutti i precedenti">fino a qui</button>` : ''}
    </div>`;
}

function drawEpisodes(it) {
  const box = $('#eps');
  if (!it.eps.length) {
    box.innerHTML = '<div class="empty">Nessun episodio disponibile.</div>';
    return;
  }

  if (it.type === 'tv') {
    const seasons = new Map();
    for (const ep of it.eps) {
      if (!seasons.has(ep.s)) seasons.set(ep.s, []);
      seasons.get(ep.s).push(ep);
    }
    const nextSeason = progress(it).next?.s;
    box.innerHTML = [...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([s, eps]) => {
      const aired = eps.filter(isAired);
      const seen = aired.filter((e) => it.watched?.[e.id]).length;
      const full = aired.length > 0 && seen === aired.length;
      return `
        <details class="season" data-season="${s}" ${s === nextSeason ? 'open' : ''}>
          <summary>
            <button class="check ${full ? 'on' : ''}" data-season-check="${s}" ${aired.length ? '' : 'disabled'}
              aria-label="Segna stagione ${s}">✓</button>
            <span class="st">Stagione ${s}<small>${seen}/${aired.length}${eps.length > aired.length ? ` · ${eps.length - aired.length} in arrivo` : ''}</small></span>
            <span class="arrow">›</span>
          </summary>
          ${eps.map((ep) => epRow(it, ep)).join('')}
        </details>`;
    }).join('');
  } else {
    const list = it.eps.slice(0, ui.podShown);
    box.innerHTML = `
      <div class="season">
        ${list.map((ep) => epRow(it, ep)).join('')}
      </div>
      ${it.eps.length > ui.podShown ? '<button class="btn" id="moreBtn" style="width:100%">Mostra altri episodi</button>' : ''}
      ${it.eps.length >= 200 ? '<p class="summary" style="margin-top:12px">Sono disponibili gli ultimi 200 episodi.</p>' : ''}`;
    const more = $('#moreBtn');
    if (more) more.onclick = () => { ui.podShown += POD_PAGE; drawEpisodes(it); };
  }

  box.querySelectorAll('[data-ep]').forEach((b) => b.onclick = () => {
    const id = Number(b.dataset.ep);
    setWatched(it.key, [id], !getItem(it.key).watched?.[id]);
    redrawKeepingScroll(it.key);
  });

  box.querySelectorAll('[data-upto]').forEach((b) => b.onclick = () => {
    const id = Number(b.dataset.upto);
    const cur = getItem(it.key);
    const order = orderedEps(cur);
    // Serie: questo e tutti i precedenti. Podcast (ordine dal più recente): questo e tutti i più vecchi.
    const idx = order.findIndex((e) => e.id === id);
    const ids = (cur.type === 'tv' ? order.slice(0, idx + 1) : order.slice(idx)).map((e) => e.id);
    setWatched(it.key, ids, true);
    toast(`${ids.length} episodi segnati`);
    redrawKeepingScroll(it.key);
  });

  box.querySelectorAll('[data-season-check]').forEach((b) => b.onclick = (e) => {
    e.preventDefault(); // non apre/chiude la stagione
    const s = Number(b.dataset.seasonCheck);
    const cur = getItem(it.key);
    const ids = cur.eps.filter((ep) => ep.s === s && isAired(ep)).map((ep) => ep.id);
    const full = ids.every((id) => cur.watched?.[id]);
    setWatched(it.key, ids, !full);
    redrawKeepingScroll(it.key);
  });
}

function redrawKeepingScroll(key) {
  const y = window.scrollY;
  const open = [...document.querySelectorAll('details.season[open]')].map((d) => d.dataset.season);
  drawItem(getItem(key));
  document.querySelectorAll('details.season').forEach((d) => { d.open = open.includes(d.dataset.season); });
  window.scrollTo(0, y);
}

/* ---------- Pagina: Altro ---------- */

function renderSettings() {
  setTitle('Altro');
  const items = Object.values(db.items);
  const tv = items.filter((i) => i.type === 'tv');
  const pod = items.filter((i) => i.type === 'pod');
  let minutes = 0;
  let epsSeen = 0;
  for (const it of items) {
    for (const ep of it.eps || []) {
      if (it.watched?.[ep.id]) { epsSeen++; minutes += ep.r || 0; }
    }
  }
  const hours = Math.round(minutes / 60);

  $('#view').innerHTML = `
    <div class="stats">
      <div class="stat"><b>${tv.length}</b><span>Serie</span></div>
      <div class="stat"><b>${pod.length}</b><span>Podcast</span></div>
      <div class="stat"><b>${epsSeen}</b><span>Episodi</span></div>
    </div>
    <div class="panel">
      <h3>Tempo totale</h3>
      <p>Circa <b style="color:var(--text)">${hours} ore</b> tra serie e podcast.</p>
    </div>
    <div class="panel">
      <h3>Aggiorna episodi</h3>
      <p>Controlla se sono usciti nuovi episodi per tutto ciò che segui. Succede anche da solo all'apertura dell'app.</p>
      <button class="btn" id="refreshBtn">Aggiorna ora</button>
    </div>
    <div class="panel">
      <h3>Backup</h3>
      <p>I dati sono salvati solo su questo telefono. Esporta un backup per non perderli o per spostarli su un altro dispositivo.</p>
      <div class="actions" style="margin:0">
        <button class="btn primary" id="exportBtn">Esporta</button>
        <label class="btn" for="importFile" style="display:inline-block">Importa</label>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
      </div>
    </div>
    <div class="panel">
      <h3>Installa sul telefono</h3>
      <p>Android (Chrome): menu ⋮ → “Installa app”. iPhone (Safari): pulsante Condividi → “Aggiungi alla schermata Home”.</p>
    </div>
    <p class="summary" style="text-align:center">Dati: TVmaze (serie TV) e Apple Podcasts (podcast).</p>
    <div class="signature">${APP_VERSION} · Creato da Denis Tramontano</div>`;

  $('#refreshBtn').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = 'Aggiornamento…';
    const n = await refreshAll(true);
    toast(n ? `Aggiornati ${n} titoli` : 'Tutto aggiornato');
    renderSettings();
  };

  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'visti', version: 1, exportedAt: new Date().toISOString(), ...db })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `visti-backup-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  $('#importFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.items !== 'object') throw new Error('formato');
      const n = Object.keys(data.items).length;
      if (!confirm(`Importare ${n} titoli? I dati attuali verranno sostituiti.`)) return;
      db = { items: data.items };
      save();
      toast('Backup importato');
      renderSettings();
    } catch (err) {
      toast('File di backup non valido');
    } finally {
      e.target.value = '';
    }
  };
}

/* ---------- Avvio ---------- */

$('#backBtn').onclick = () => {
  if (history.length > 1) history.back();
  else location.hash = '#/library';
};

window.addEventListener('hashchange', route);
route();

// All'avvio controlla in background i nuovi episodi.
refreshAll().then((n) => {
  if (n && (location.hash === '' || location.hash === '#/library')) renderLibrary();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
