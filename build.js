#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = (process.env.CEE_BASE || 'https://cee.buzz').replace(/\/+$/, '');
const API = BASE + '/api/android';
const OUT = path.resolve(process.env.OUT || 'docs');
const PAGES = parseInt(process.env.PAGES, 10) || 10;
const GROUP_PAGES = parseInt(process.env.GROUP_PAGES, 10) || 4;
const CHUNK = parseInt(process.env.CHUNK, 10) || 100;
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 10;
const NAME_LANG = process.env.NAME_LANG === 'en' ? 'en' : 'ar';
const CACHE_FILE = path.resolve(process.env.CACHE_FILE || 'cee-meta-cache.json');
const PAGE_SIZE = 30;
const TIMEOUT_MS = 20000;
const ID_PREFIX = 'cee:';

const SORTS = [
  ['new', 'desc', 'تاريخ الرفع - الأحدث'],
  ['old', 'asc', 'تاريخ الرفع - الأقدم'],
  ['views', 'views_desc', 'الأكثر مشاهدة'],
  ['rating', 'stars_desc', 'أعلى تقييم IMDb'],
  ['ar_asc', 'ar_title_asc', 'أبجدياً (أ-ي)'],
  ['ar_desc', 'ar_title_desc', 'أبجدياً (ي-أ)'],
  ['en_asc', 'en_title_asc', 'أبجدياً (A-Z)'],
  ['en_desc', 'en_title_desc', 'أبجدياً (Z-A)'],
];

const KINDS = [
  { type: 'movie', kind: 1, label: 'أفلام' },
  { type: 'series', kind: 2, label: 'مسلسلات' },
];

const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
  Referer: BASE,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

function pickTitle(it) {
  const ar = str(it && it.ar_title);
  const en = str(it && it.en_title);
  return (NAME_LANG === 'en' ? en || ar : ar || en) || 'بدون عنوان';
}

function itemType(it, fallbackType) {
  if (it && it.kind !== undefined && it.kind !== null) {
    return parseInt(it.kind, 10) === 2 ? 'series' : 'movie';
  }
  return fallbackType || 'movie';
}

async function fetchJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: HEADERS });
      if (res.status === 429) {
        await sleep(1500 * (i + 1));
        lastErr = new Error('HTTP 429');
        continue;
      }
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
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    })
  );
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

async function fetchSortedList(kind, sort, categoryId = '', pages = PAGES) {
  const items = [];
  for (let page = 0; page < pages; page++) {
    const url =
      API +
      '/video/V/2?videoKind=' +
      kind +
      '&langNb=&itemsPerPage=' +
      PAGE_SIZE +
      '&pageNumber=' +
      page +
      '&level=0&sortParam=' +
      sort +
      (categoryId ? '&categories=' + categoryId : '');
    let list;
    try {
      list = await fetchJson(url);
    } catch (e) {
      if (page === 0 && !categoryId) throw e;
      break;
    }
    if (!Array.isArray(list) || !list.length) break;
    list.forEach((it) => {
      if (it && it.nb) items.push(it);
    });
    if (!categoryId) process.stdout.write('\r   pages read: ' + (page + 1) + '  items: ' + items.length + '   ');
  }
  if (!categoryId) process.stdout.write('\n');
  return items;
}

async function fetchNewlyAdded() {
  const items = [];
  for (let page = 0; page < GROUP_PAGES; page++) {
    const url = API + '/newlyVideosItems/level/0/offset/12/page/' + page + '/';
    let list;
    try { list = await fetchJson(url); } catch (e) { break; }
    if (!Array.isArray(list) || !list.length) break;
    list.forEach((it) => { if (it && it.nb) items.push(it); });
  }
  return items;
}

async function fetchDynamicGroups() {
  try {
    let groups = await fetchJson(API + '/videoGroup/lang/ar/level/0').catch(() => null);
    if (!groups) groups = await fetchJson(API + '/videoGroups/lang/ar/level/0').catch(() => []);
    return Array.isArray(groups) ? groups.filter((g) => g && g.id && (g.title || g.ar_title)) : [];
  } catch (e) { return []; }
}

async function fetchGroupItems(gid) {
  const items = [];
  for (let page = 0; page < GROUP_PAGES; page++) {
    const url = API + '/videoListPagination/groupID/' + gid + '/level/0/itemsPerPage/24/page/' + page;
    let list;
    try { list = await fetchJson(url); } catch (e) { break; }
    if (!Array.isArray(list) || !list.length) break;
    list.forEach((it) => { if (it && it.nb) items.push(it); });
  }
  return items;
}

async function fetchCategories() {
  try {
    const cats = await fetchJson(API + '/videoCategory/lang/ar/level/0').catch(() => []);
    return Array.isArray(cats) ? cats.filter((c) => c && c.id && (c.title || c.ar_title)) : [];
  } catch (e) { return []; }
}

function toPreview(it, type) {
  const nb = str(it.nb);
  const meta = {
    id: ID_PREFIX + nb,
    type,
    name: pickTitle(it),
    poster: str(it.imgObjUrl) || str(it.img) || undefined,
  };
  if (it.year) meta.releaseInfo = str(it.year);
  const r = parseFloat(it.stars);
  if (!isNaN(r) && r > 0) meta.imdbRating = r.toFixed(1);
  return meta;
}

async function fetchFullMeta(nb, type, fallbackItem) {
  const d = await fetchJson(API + '/allVideoInfo/id/' + nb).catch(() => fallbackItem || {});
  const src = d && d.nb ? d : fallbackItem || {};

  const meta = {
    id: ID_PREFIX + nb,
    type,
    name: pickTitle(src),
    poster: str(src.imgObjUrl) || str(src.img) || undefined,
    background: str(src.imgObjUrl) || str(src.img) || undefined,
    description: str(src.ar_content) || str(src.en_content) || pickTitle(src),
    releaseInfo: src.year ? str(src.year) : undefined,
    genres: (Array.isArray(src.categories) ? src.categories : [])
      .map((c) => str(c.ar_title) || str(c.en_title))
      .filter(Boolean),
    cast: (Array.isArray(src.actorsInfo) ? src.actorsInfo : [])
      .map((a) => str(a.name))
      .filter(Boolean),
    director: (Array.isArray(src.directorsInfo) ? src.directorsInfo : [])
      .map((a) => str(a.name))
      .filter(Boolean),
  };

  const r = parseFloat(src.stars);
  if (!isNaN(r) && r > 0) meta.imdbRating = r.toFixed(1);
  const secs = parseFloat(src.duration);
  if (!isNaN(secs) && secs > 0) meta.runtime = Math.round(secs / 60) + ' min';

  if (type === 'series') {
    const eps = await fetchJson(API + '/videoSeason/id/' + nb).catch(() => []);
    const base = Date.UTC(parseInt(src.year, 10) || 2020, 0, 1);
    meta.videos = (Array.isArray(eps) ? eps : [])
      .filter((e) => e && e.nb)
      .map((e) => ({
        e,
        season: parseInt(e.season, 10) || 1,
        episode: parseInt(e.episodeNummer, 10) || 1,
      }))
      .sort((a, b) => a.season - b.season || a.episode - b.episode)
      .map((x, i) => ({
        id: ID_PREFIX + x.e.nb,
        title: 'الموسم ' + x.season + ' - الحلقة ' + x.episode,
        season: x.season,
        episode: x.episode,
        thumbnail: str(x.e.imgObjUrl) || str(x.e.img) || meta.poster,
        released: new Date(base + i * 86400000).toISOString(),
      }));
  }

  return meta;
}

async function main() {
  console.log('Cee Full IPTV Builder (Groups + Categories + Search Index)\n');

  const cache = loadCache();
  const lists = [];
  const allItems = new Map();

  function registerItems(rawList, defaultType) {
    rawList.forEach((it) => {
      if (!it || !it.nb) return;
      const t = itemType(it, defaultType);
      allItems.set(t + ':' + it.nb, { type: t, nb: str(it.nb), it });
    });
  }

  console.log('Reading Cee: أحدث الإضافات...');
  const newly = await fetchNewlyAdded();
  if (newly.length) {
    registerItems(newly, null);
    const newlyMovies = newly.filter((it) => itemType(it, 'movie') === 'movie');
    const newlySeries = newly.filter((it) => itemType(it, 'movie') === 'series');
    if (newlyMovies.length) lists.push({ type: 'movie', id: 'cee_newly_movie', name: 'Cee | أحدث الإضافات - أفلام', items: newlyMovies });
    if (newlySeries.length) lists.push({ type: 'series', id: 'cee_newly_series', name: 'Cee | أحدث الإضافات - مسلسلات', items: newlySeries });
  }

  console.log('Checking Cee Groups (المجموعات)...');
  const groups = await fetchDynamicGroups();
  for (const g of groups) {
    const gid = str(g.id);
    const gTitle = str(g.title) || str(g.ar_title);
    if (!gid || !gTitle) continue;
    const gItems = await fetchGroupItems(gid);
    if (!gItems.length) continue;
    registerItems(gItems, null);

    const gMovies = gItems.filter((it) => itemType(it, 'movie') === 'movie');
    const gSeries = gItems.filter((it) => itemType(it, 'movie') === 'series');

    if (gMovies.length) lists.push({ type: 'movie', id: 'cee_group_' + gid + '_movie', name: 'Cee | ' + gTitle + ' (أفلام)', items: gMovies });
    if (gSeries.length) lists.push({ type: 'series', id: 'cee_group_' + gid + '_series', name: 'Cee | ' + gTitle + ' (مسلسلات)', items: gSeries });
  }

  console.log('Checking Cee Categories (التصنيفات)...');
  const categories = await fetchCategories();
  for (const cat of categories) {
    const cid = str(cat.id);
    const cTitle = str(cat.title) || str(cat.ar_title);
    if (!cid || !cTitle) continue;
    
    const mItems = await fetchSortedList(1, 'new', cid, GROUP_PAGES);
    if (mItems.length) {
      registerItems(mItems, 'movie');
      lists.push({ type: 'movie', id: 'cee_cat_' + cid + '_movie', name: 'Cee | ' + cTitle + ' (أفلام)', items: mItems });
    }
    const sItems = await fetchSortedList(2, 'new', cid, GROUP_PAGES);
    if (sItems.length) {
      registerItems(sItems, 'series');
      lists.push({ type: 'series', id: 'cee_cat_' + cid + '_series', name: 'Cee | ' + cTitle + ' (مسلسلات)', items: sItems });
    }
  }

  console.log('Reading Cee: Standard Sorts...');
  for (const k of KINDS) {
    for (const [key, sort, label] of SORTS) {
      console.log('   ' + k.label + ' - ' + label);
      let items;
      try {
        items = await fetchSortedList(k.kind, sort);
      } catch (e) {
        console.log('\nCould not reach Cee. Make sure you are connected inside Iraq.');
        process.exit(1);
      }
      lists.push({ type: k.type, id: 'cee_' + k.type + '_' + key, name: 'Cee | ' + k.label + ' - ' + label, items });
      registerItems(items, k.type);
    }
  }

  const todo = [...allItems.entries()].filter(([key, val]) => {
    if (!cache[key]) return true;
    if (val.type === 'series' && (!cache[key].videos || !cache[key].videos.length)) return true;
    return false;
  });

  console.log('\nTotal unique Cee items: ' + allItems.size + ', fetching full meta/episodes for: ' + todo.length);

  let done = 0;
  let lastSave = Date.now();
  await pool(todo, CONCURRENCY, async ([key, val]) => {
    try {
      cache[key] = await fetchFullMeta(val.nb, val.type, val.it);
    } catch (e) {
      cache[key] = toPreview(val.it, val.type);
    }
    done++;
    if (done % 20 === 0 || done === todo.length) {
      process.stdout.write('\r   fetched meta: ' + done + '/' + todo.length + '   ');
    }
    if (Date.now() - lastSave > 15000) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
      lastSave = Date.now();
    }
  });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  process.stdout.write('\n');

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // بناء فهرس البحث الشامل (Search Index)
  const searchIndex = [];
  let metaCount = 0;
  allItems.forEach((val, key) => {
    const metaObj = cache[key] || toPreview(val.it, val.type);
    const fileName = ID_PREFIX + val.nb + '.json';
    writeJson(path.join(OUT, 'meta', val.type, fileName), { meta: metaObj });
    metaCount++;

    searchIndex.push({
      id: ID_PREFIX + val.nb,
      type: val.type,
      name: metaObj.name,
      ar: str(val.it.ar_title),
      en: str(val.it.en_title),
      poster: metaObj.poster,
      releaseInfo: metaObj.releaseInfo,
      imdbRating: metaObj.imdbRating
    });
  });
  writeJson(path.join(OUT, 'search-index.json'), searchIndex);
  console.log('Written ' + metaCount + ' static meta files & search-index.json.');

  const catalogsMeta = [
    { type: 'movie', id: 'cee_search_movie', name: 'Cee | بحث الأفلام', extra: [{ name: 'search', isRequired: true }] },
    { type: 'series', id: 'cee_search_series', name: 'Cee | بحث المسلسلات', extra: [{ name: 'search', isRequired: true }] }
  ];

  for (const l of lists) {
    const seen = new Set();
    const metas = [];
    l.items.forEach((it) => {
      const id = ID_PREFIX + it.nb;
      if (seen.has(id)) return;
      seen.add(id);
      metas.push(toPreview(it, l.type));
    });
    if (!metas.length) continue;

    catalogsMeta.push({ type: l.type, id: l.id, name: l.name, extra: [{ name: 'skip' }] });

    const dir = path.join(OUT, 'catalog', l.type);
    for (let skip = 0; skip <= metas.length; skip += CHUNK) {
      const page = { metas: metas.slice(skip, skip + CHUNK) };
      if (skip === 0) writeJson(path.join(dir, l.id + '.json'), page);
      writeJson(path.join(dir, l.id, 'skip=' + skip + '.json'), page);
    }
    if (metas.length % CHUNK !== 0) {
      writeJson(path.join(dir, l.id, 'skip=' + metas.length + '.json'), { metas: [] });
    }
  }

  writeJson(path.join(OUT, 'manifest.json'), {
    id: 'community.cee.iptv.catalog',
    version: '3.1.0',
    name: 'Cee Iraq IPTV Catalog',
    description: 'كتالوج وبحث Cee الشامل مع الأقسام المتجددة والتصنيفات والمجموعات',
    resources: ['catalog', 'meta'],
    types: ['movie', 'series'],
    idPrefixes: [ID_PREFIX],
    catalogs: catalogsMeta,
  });

  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  console.log('\nDone! Publish the "' + path.basename(OUT) + '" folder with GitHub Pages.');
}

main().catch((e) => {
  console.error('Failed:', e && e.message ? e.message : e);
  process.exit(1);
});
