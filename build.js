#!/usr/bin/env node
'use strict';
// Cinemana static catalog builder (Stremio addon protocol, catalog only).
//
// Run it ONCE from an Earthlink / Iraq connection (Cinemana is blocked elsewhere):
//   node build.js
// It writes a ./docs folder. Publish that folder with GitHub Pages and add
//   https://<user>.github.io/<repo>/manifest.json
// as an addon in Nuvio. Items carry IMDb ids, so Nuvio shows its own details
// and asks our Cinemana / Cee plugins (which receive the TMDB id) for streams.
//
// Needs Node 18+ (built-in fetch). No dependencies.
//
// Optional environment variables:
//   TMDB_KEY     your TMDB v3 key (a default is built in)
//   PAGES        Cinemana pages (30 items each) to read per catalog   (default 20)
//   CHUNK        items per catalog file                               (default 200)
//   CONCURRENCY  parallel TMDB lookups                                (default 8)
//   NAME_LANG    ar (default) or en : language of the titles in the lists
//   OUT          output folder                                        (default docs)

const fs = require('fs');
const path = require('path');

const TMDB_KEY = process.env.TMDB_KEY || '16fc93e65cf8c9184b8ac53006288677';
const BASE = (process.env.CINEMANA_BASE || 'https://cinemana.shabakaty.cc').replace(/\/+$/, '');
const API = BASE + '/api/android';
const OUT = path.resolve(process.env.OUT || 'docs');
const PAGES = parseInt(process.env.PAGES, 10) || 20;
const CHUNK = parseInt(process.env.CHUNK, 10) || 200;
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 8;
const NAME_LANG = process.env.NAME_LANG === 'en' ? 'en' : 'ar';
const CACHE_FILE = path.resolve(process.env.CACHE_FILE || 'tmdb-cache.json');
const PAGE_SIZE = 30;
const TIMEOUT_MS = 20000;

const SORTS = [
  ['new', 'desc', 'الأحدث رفعاً'],
  ['release', 'r_desc', 'الأحدث إصداراً'],
  ['views', 'views_desc', 'الأكثر مشاهدة'],
  ['rating', 'stars_desc', 'الأعلى تقييماً IMDb'],
];
const KINDS = [
  { type: 'movie', kind: 1, label: 'أفلام' },
  { type: 'series', kind: 2, label: 'مسلسلات' },
];

// ----------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, headers, tries) {
  let lastErr;
  for (let i = 0; i < (tries || 3); i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: headers || { Accept: 'application/json' } });
      if (res.status === 429) { await sleep(1500 * (i + 1)); lastErr = new Error('HTTP 429'); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(500 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim();
}

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const unique = (a) => a.filter((x, i) => x && a.indexOf(x) === i);

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }));
}

// ------------------------------------------------------------ Cinemana lists
async function fetchList(kind, sort) {
  const items = [];
  for (let page = 0; page < PAGES; page++) {
    const url = API + '/video/V/2?videoKind=' + kind + '&langNb=&itemsPerPage=' + PAGE_SIZE +
      '&pageNumber=' + page + '&level=0&sortParam=' + sort;
    let list;
    try {
      list = await fetchJson(url, {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      });
    } catch (e) {
      if (page === 0) throw e;
      console.log('   page ' + page + ' failed (' + e.message + '), stopping this list');
      break;
    }
    if (!Array.isArray(list) || !list.length) break;
    list.forEach((it) => { if (it && it.nb) items.push(it); });
    process.stdout.write('\r   pages read: ' + (page + 1) + '  items: ' + items.length + '   ');
  }
  process.stdout.write('\n');
  return items;
}

// -------------------------------------------------------------- TMDB mapping
function resultYear(r) {
  return parseInt(str(r.release_date || r.first_air_date).substring(0, 4), 10) || null;
}

function pickResult(results, titleNorms, year, isTv) {
  let best = null;
  let bestScore = 0;
  (results || []).forEach((r) => {
    const cands = [normalize(r.title || r.name), normalize(r.original_title || r.original_name)].filter(Boolean);
    let score = 0;
    if (cands.some((c) => titleNorms.indexOf(c) !== -1)) score = 100;
    else if (cands.some((c) => titleNorms.some((t) => Math.min(c.length, t.length) >= 3 && (c.indexOf(t) !== -1 || t.indexOf(c) !== -1)))) score = 50;
    if (!score) return;
    const y = resultYear(r);
    if (year && y) {
      const d = Math.abs(y - year);
      if (d === 0) score += 30;
      else if (d === 1) score += 10;
      else if (!isTv) score -= 60; // movies must be close to the year
    }
    if (score > bestScore) { bestScore = score; best = r; }
  });
  return bestScore >= 80 ? best : null; // exact title, or partial title + same year
}

async function tmdbSearch(kind, query, year, lang) {
  let url = 'https://api.themoviedb.org/3/search/' + kind + '?api_key=' + TMDB_KEY +
    '&include_adult=false&language=' + lang + '&query=' + encodeURIComponent(query);
  if (year) url += (kind === 'tv' ? '&first_air_date_year=' : '&year=') + year;
  const j = await fetchJson(url);
  return (j && j.results) || [];
}

// -> { tmdb, imdb|null, poster|null } or null when nothing matches
async function mapItem(it) {
  const isTv = Number(it.kind) === 2;
  const kind = isTv ? 'tv' : 'movie';
  const year = parseInt(it.year, 10) || null;
  const titles = unique([str(it.en_title), str(it.ar_title)]);
  const norms = titles.map(normalize).filter(Boolean);

  for (const t of titles) {
    const lang = /[\u0600-\u06ff]/.test(t) ? 'ar' : 'en-US';
    let hit = pickResult(await tmdbSearch(kind, t, year, lang), norms, year, isTv);
    if (!hit && year) hit = pickResult(await tmdbSearch(kind, t, null, lang), norms, year, isTv);
    if (hit) {
      const ext = await fetchJson('https://api.themoviedb.org/3/' + kind + '/' + hit.id +
        '/external_ids?api_key=' + TMDB_KEY).catch(() => ({}));
      return { tmdb: hit.id, imdb: ext && ext.imdb_id ? ext.imdb_id : null, poster: hit.poster_path || null };
    }
  }
  return null;
}

// ------------------------------------------------------------------- output
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { return {}; }
}

async function main() {
  console.log('Cinemana catalog builder');
  console.log('Pages per catalog: ' + PAGES + ' (x' + PAGE_SIZE + ' items), output: ' + OUT + '\n');

  const cache = loadCache();
  const lists = []; // { type, id, name, items }
  const allItems = new Map();

  for (const k of KINDS) {
    for (const [key, sort, label] of SORTS) {
      console.log('Reading: ' + k.label + ' - ' + label);
      let items;
      try {
        items = await fetchList(k.kind, sort);
      } catch (e) {
        console.log('\nCould not reach Cinemana (' + e.message + ').');
        console.log('Run this script while connected to Earthlink / inside Iraq, then try again.');
        process.exit(1);
      }
      lists.push({ type: k.type, id: 'cinemana_' + k.type + '_' + key, name: 'سينمانا | ' + k.label + ' - ' + label, items });
      items.forEach((it) => allItems.set(k.type + ':' + it.nb, it));
    }
  }

  const todo = [...allItems.entries()].filter(([key]) => !(key in cache));
  console.log('\nUnique titles: ' + allItems.size + ', new to look up on TMDB: ' + todo.length);

  let done = 0;
  let lastSave = Date.now();
  await pool(todo, CONCURRENCY, async ([key, it]) => {
    try {
      cache[key] = await mapItem(it);
    } catch (e) {
      return; // network hiccup: leave it out of the cache, it is retried next run
    }
    done++;
    if (done % 25 === 0 || done === todo.length) {
      process.stdout.write('\r   looked up: ' + done + '/' + todo.length + '   ');
    }
    if (Date.now() - lastSave > 15000) { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); lastSave = Date.now(); }
  });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  process.stdout.write('\n');

  // ---- write the static addon
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const catalogsMeta = [];
  let unmatchedTitles = 0;
  allItems.forEach((it, key) => { const m = cache[key]; if (!m || !m.imdb) unmatchedTitles++; });
  for (const l of lists) {
    const seen = new Set();
    const metas = [];
    l.items.forEach((it) => {
      const m = cache[l.type + ':' + it.nb];
      if (!m || !m.imdb) return;
      if (seen.has(m.imdb)) return;
      seen.add(m.imdb);
      const arTitle = str(it.ar_title);
      const enTitle = str(it.en_title);
      const meta = {
        id: m.imdb,
        type: l.type,
        name: (NAME_LANG === 'en' ? enTitle || arTitle : arTitle || enTitle) || m.imdb,
        poster: m.poster ? 'https://image.tmdb.org/t/p/w342' + m.poster : (it.imgObjUrl || undefined),
      };
      if (it.year) meta.releaseInfo = str(it.year);
      const r = parseFloat(it.stars);
      if (!isNaN(r) && r > 0) meta.imdbRating = r.toFixed(1);
      metas.push(meta);
    });

    catalogsMeta.push({ type: l.type, id: l.id, name: l.name, extra: [{ name: 'skip' }] });

    // /catalog/{type}/{id}.json and /catalog/{type}/{id}/skip=N.json
    const dir = path.join(OUT, 'catalog', l.type);
    for (let skip = 0; skip <= metas.length; skip += CHUNK) {
      const page = { metas: metas.slice(skip, skip + CHUNK) };
      if (skip === 0) writeJson(path.join(dir, l.id + '.json'), page);
      writeJson(path.join(dir, l.id, 'skip=' + skip + '.json'), page);
    }
    // Stremio asks for skip = (items already loaded) next, so answer that with an empty page
    if (metas.length % CHUNK !== 0) {
      writeJson(path.join(dir, l.id, 'skip=' + metas.length + '.json'), { metas: [] });
    }
    console.log(l.name + ': ' + metas.length + ' items');
  }

  writeJson(path.join(OUT, 'manifest.json'), {
    id: 'community.cinemana.catalog',
    version: '1.0.0',
    name: 'Cinemana Catalog',
    description: 'كتالوج سينمانا (قوائم ثابتة، الروابط من بلوغن سينمانا وCee)',
    resources: ['catalog'],
    types: ['movie', 'series'],
    catalogs: catalogsMeta,
  });
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  fs.writeFileSync(path.join(OUT, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>Cinemana Catalog</title>' +
    '<body style="font-family:sans-serif;padding:1rem"><h3>Cinemana Catalog</h3>' +
    '<p>Add <code>manifest.json</code> from this address as an addon in Nuvio.</p>' +
    '<p>Built: ' + new Date().toISOString() + '</p></body>');

  console.log('\nDone. ' + (allItems.size - unmatchedTitles) + ' of ' + allItems.size + ' titles matched an IMDb id; ' + unmatchedTitles + ' were left out.');
  console.log('Now publish the "' + path.basename(OUT) + '" folder with GitHub Pages.');
}

main().catch((e) => { console.error('Failed:', e && e.message ? e.message : e); process.exit(1); });
