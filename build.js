#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = (process.env.CEE_BASE || 'https://cee.buzz').replace(/\/+$/, '');
const API = BASE + '/api/android';
const OUT = path.resolve(process.env.OUT || 'docs');
const IMDB_CACHE_FILE = path.resolve(process.env.IMDB_CACHE_FILE || 'cee-imdb-cache.json');
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 10;
const RETRY_EMPTY_MS = 3 * 24 * 3600 * 1000;
const TIMEOUT_MS = 20000;

const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
  Referer: BASE,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TT_RE = /tt\d{6,10}/;

async function fetchJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: HEADERS });
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

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function listMeta(type) {
  const dir = path.join(OUT, 'meta', type);
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const f of files) {
    const m = /^cee:(\d+)\.json$/.exec(f);
    if (!m) continue;
    const j = readJson(path.join(dir, f), null);
    out.push({ nb: m[1], meta: j && j.meta ? j.meta : null });
  }
  return out;
}

async function main() {
  console.log('Cee -> IMDb map builder\n');
  const movies = listMeta('movie');
  const series = listMeta('series');
  if (!movies.length && !series.length) {
    console.log('No meta files found in ' + path.join(OUT, 'meta') + '. Run build.js first.');
    process.exit(1);
  }

  const cache = readJson(IMDB_CACHE_FILE, {});
  const now = Date.now();
  const todo = [];
  for (const t of [['movie', movies], ['series', series]]) {
    for (const it of t[1]) {
      const key = t[0] + ':' + it.nb;
      const c = cache[key];
      if (c && c.tt) continue;
      if (c && !c.tt && c.ok && now - c.at < RETRY_EMPTY_MS) continue;
      todo.push(key);
    }
  }
  console.log('Movies: ' + movies.length + ' | Series: ' + series.length + ' | to fetch: ' + todo.length);

  let done = 0, failed = 0;
  await pool(todo, CONCURRENCY, async (key) => {
    const nb = key.split(':')[1];
    try {
      const d = await fetchJson(API + '/allVideoInfo/id/' + nb);
      if (d && d.nb) {
        const m = TT_RE.exec(String((d && d.imdbUrlRef) || ''));
        cache[key] = { tt: m ? m[0] : '', ok: true, at: Date.now() };
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
    }
    done++;
    if (done % 50 === 0 || done === todo.length) process.stdout.write('\r   fetched: ' + done + '/' + todo.length + '   ');
  });
  if (todo.length) process.stdout.write('\n');
  fs.writeFileSync(IMDB_CACHE_FILE, JSON.stringify(cache));

  const map = { v: 1, m: {}, s: {}, e: {} };
  let mOk = 0, sOk = 0, epCount = 0;
  for (const it of movies) {
    const c = cache['movie:' + it.nb];
    if (c && c.tt) { map.m[it.nb] = c.tt; mOk++; }
  }
  for (const it of series) {
    const c = cache['series:' + it.nb];
    if (!c || !c.tt) continue;
    map.s[it.nb] = c.tt;
    sOk++;
    const vids = it.meta && Array.isArray(it.meta.videos) ? it.meta.videos : [];
    for (const v of vids) {
      const m = /^cee:(\d+)$/.exec(String(v && v.id));
      if (!m || !v.season || !v.episode) continue;
      map.e[m[1]] = [it.nb, v.season, v.episode];
      epCount++;
    }
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'cee-map.json'), JSON.stringify(map));
  console.log('\nMovies with IMDb: ' + mOk + '/' + movies.length);
  console.log('Series with IMDb: ' + sOk + '/' + series.length + ' (episodes mapped: ' + epCount + ')');
  if (failed) console.log('Failed requests (will retry next run): ' + failed);
  console.log('Written ' + path.join(OUT, 'cee-map.json'));
}

main().catch((e) => { console.error(e); process.exit(1); });
