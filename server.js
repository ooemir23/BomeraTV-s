const express = require('express');
const multer = require('multer');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'degistir';
const TZ = process.env.TZ_NAME || 'Europe/Istanbul';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const uid = () => Math.random().toString(36).slice(2, 10);

let db = { videos: [], matches: [], birthdays: [], times: ['13:00', '19:00'], duration: 40, imageSeconds: 10, reviews: [], leagues: null, channels: {}, leagueChannels: {}, showStandings: true, trafficApi: '', trafficSecret: '', qrs: [], showQr: true, fxMode: 'auto', safeInset: 0, safeGuide: false, showOnThisDay: true, pharmacy: { enabled: true, key: '', il: 'İstanbul', districts: [] }, news: { enabled: true, key: '', tag: 'general', hours: 3 } };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

// ---- Diske yazılan önbellek: yeniden başlatmada elde veri olur, her veri kendi süresine göre yenilenir ----
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { /* ilk açılış */ }
let cacheTimer;
const cacheSave = () => { clearTimeout(cacheTimer); cacheTimer = setTimeout(() => fs.writeFile(CACHE_FILE, JSON.stringify(cache), () => {}), 1500); };
const cacheAge = key => (cache[key] ? Date.now() - cache[key].at : Infinity);
const cacheGet = key => (cache[key] ? cache[key].data : null);
const cachePut = (key, data) => { cache[key] = { at: Date.now(), data }; cacheSave(); };
const MIN = 60 * 1000, HOUR = 60 * MIN;

let traffic = null; // İBB trafik endeksi: Türkiye'den bağlanan tarayıcıların Worker üzerinden aldığı, Worker'ın imzaladığı değerler
const crypto = require('crypto');
const QRCode = require('qrcode');
function trafficSecret() {
  if (!db.trafficSecret) { db.trafficSecret = crypto.randomBytes(32).toString('hex'); save(); }
  return db.trafficSecret;
}

let weather = cacheGet('weather');
async function refreshWeather() {
  if (weather && cacheAge('weather') < 30 * MIN) return; // taze, tekrar sorma
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=41.01&longitude=28.98&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day&daily=temperature_2m_max,temperature_2m_min&timezone=Europe%2FIstanbul&forecast_days=1');
    const j = await r.json();
    weather = {
      temp: j.current.temperature_2m, feels: j.current.apparent_temperature, code: j.current.weather_code,
      wind: j.current.wind_speed_10m, day: !!j.current.is_day,
      max: j.daily.temperature_2m_max[0], min: j.daily.temperature_2m_min[0],
    };
    cachePut('weather', weather);
    broadcast({ type: 'weather', weather });
  } catch (e) { console.error('Hava durumu alınamadı:', e.message); }
}
refreshWeather();
setInterval(refreshWeather, 10 * MIN); // kontrol sıklığı; ağa yalnızca 30 dk'dan eskiyse gidilir

let rates = cacheGet('rates') || { usd: null, eur: null, gold: null, updated: null };
async function refreshRates() {
  if (cacheAge('rates:fx') > 60 * MIN || rates.gbp == null) { // döviz kaynağı günde bir güncellenir; saatte bir sormak yeter
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD');
      const j = await r.json();
      const t = j.rates.TRY;
      rates = { ...rates, usd: t, eur: t / j.rates.EUR, gbp: j.rates.GBP ? t / j.rates.GBP : rates.gbp, updated: new Date().toISOString() };
      cachePut('rates:fx', true); cachePut('rates', rates);
      broadcast({ type: 'rates', rates });
    } catch (e) { console.error('Kur alınamadı:', e.message); }
  }
  // altın + BIST 100 (aynı kaynak): borsa saatlerinde (hafta içi 09:30-18:30) 15 dk, dışında 2 saatte bir
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const pv = t => (parts.find(p => p.type === t) || {}).value;
  const mins = Number(pv('hour')) * 60 + Number(pv('minute')), weekday = !['Sat', 'Sun'].includes(pv('weekday'));
  const marketOpen = weekday && mins >= 9 * 60 + 30 && mins <= 18 * 60 + 30;
  if (cacheAge('rates:gold') > (marketOpen ? 15 * MIN : 2 * HOUR) || rates.bist == null) {
    try {
      const g = await (await fetch('https://finans.truncgil.com/v4/today.json')).json();
      rates = { ...rates, gold: Number(g.GRA.Selling), goldCh: Number(g.GRA.Change) };
      if (g.XU100 && Number(g.XU100.Selling) > 0) rates = { ...rates, bist: Number(g.XU100.Selling), bistCh: Number(g.XU100.Change) };
      cachePut('rates:gold', true); cachePut('rates', rates);
      broadcast({ type: 'rates', rates });
    } catch (e) { console.error('Altın/BIST alınamadı:', e.message); if (!rates.gold || rates.bist == null) setTimeout(refreshRates, 30 * 1000); }
  }
  // Bitcoin (USD, 24 saatlik değişim): 7/24 işlem görür, 10 dk
  if (cacheAge('rates:btc') > 10 * MIN) {
    try {
      let btc;
      try {
        const j = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true')).json();
        btc = { usd: Number(j.bitcoin.usd), ch: Number(j.bitcoin.usd_24h_change) };
        if (!(btc.usd > 0)) throw new Error('boş');
      } catch (e1) {
        const j = await (await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT')).json(); // yedek kaynak
        btc = { usd: Number(j.lastPrice), ch: Number(j.priceChangePercent) };
        if (!(btc.usd > 0)) throw new Error('Bitcoin verisi alınamadı');
      }
      rates = { ...rates, btc: btc.usd, btcCh: btc.ch };
      cachePut('rates:btc', true); cachePut('rates', rates);
      broadcast({ type: 'rates', rates });
    } catch (e) { console.error('Bitcoin alınamadı:', e.message); }
  }
}
refreshRates();
setInterval(refreshRates, 5 * MIN); // kontrol sıklığı; ağa süre dolunca gidilir

const CATALOG = [
  ['tur.1', 'Süper Lig', 'Türkiye'], ['tur.2', 'TFF 1. Lig', 'Türkiye'],
  ['uefa.champions', 'Şampiyonlar Ligi', 'Avrupa Kupaları'], ['uefa.europa', 'Avrupa Ligi', 'Avrupa Kupaları'],
  ['uefa.europa.conf', 'Konferans Ligi', 'Avrupa Kupaları'], ['uefa.nations', 'UEFA Uluslar Ligi', 'Avrupa Kupaları'],
  ['uefa.champions_qual', 'Şampiyonlar Ligi Eleme', 'Avrupa Kupaları'], ['uefa.euro', 'Avrupa Şampiyonası', 'Avrupa Kupaları'],
  ['esp.1', 'La Liga', 'İspanya'], ['esp.2', 'La Liga 2', 'İspanya'],
  ['eng.1', 'Premier Lig', 'İngiltere'], ['eng.2', 'Championship', 'İngiltere'], ['eng.fa', 'FA Cup', 'İngiltere'],
  ['ita.1', 'Serie A', 'İtalya'], ['ita.2', 'Serie B', 'İtalya'],
  ['ger.1', 'Bundesliga', 'Almanya'], ['ger.2', '2. Bundesliga', 'Almanya'],
  ['fra.1', 'Ligue 1', 'Fransa'], ['fra.2', 'Ligue 2', 'Fransa'],
  ['ned.1', 'Hollanda Eredivisie', 'Diğer Ülkeler'], ['por.1', 'Portekiz Ligi', 'Diğer Ülkeler'],
  ['bel.1', 'Belçika Ligi', 'Diğer Ülkeler'], ['sco.1', 'İskoçya Ligi', 'Diğer Ülkeler'],
  ['gre.1', 'Yunanistan Süper Ligi', 'Diğer Ülkeler'], ['aut.1', 'Avusturya Ligi', 'Diğer Ülkeler'],
  ['sui.1', 'İsviçre Ligi', 'Diğer Ülkeler'], ['rus.1', 'Rusya Ligi', 'Diğer Ülkeler'],
  ['usa.1', 'MLS', 'Diğer Ülkeler'], ['bra.1', 'Brezilya Serie A', 'Diğer Ülkeler'], ['arg.1', 'Arjantin Ligi', 'Diğer Ülkeler'],
  ['fifa.world', 'Dünya Kupası', 'Diğer Ülkeler'],
];
const DEFAULT_LEAGUES = ['uefa.champions', 'uefa.europa', 'tur.1', 'tur.2', 'esp.1', 'eng.1', 'ita.1', 'ger.1', 'fra.1'];
const NO_TABLE = new Set(['eng.fa', 'fifa.world']);
const standings = new Map(); // code -> satırlar
for (const k of Object.keys(cache)) if (k.startsWith('standings:')) standings.set(k.slice(10), cache[k].data);
const standingsDirty = new Set(); // maçı biten liglerin kodları: tablo hemen yenilensin
async function refreshStandings() {
  const targets = CATALOG.filter(([code, , group]) => enabledLeagues().some(([c]) => c === code) && group !== 'Avrupa Kupaları' && !NO_TABLE.has(code));
  await Promise.all(targets.map(async ([code]) => {
    if (!standingsDirty.has(code) && standings.has(code) && cacheAge('standings:' + code) < 6 * HOUR) return; // taze
    try {
      standingsDirty.delete(code);
      const r = await fetch(`https://site.api.espn.com/apis/v2/sports/soccer/${code}/standings`);
      const j = await r.json();
      const ch = j.children || [];
      if (ch.length !== 1) { standings.delete(code); return; } // grup/konferans yapılı veya veri yok
      const num = (e, n) => { const x = e.stats.find(s => s.name === n); return x ? (x.displayValue ?? String(x.value)) : ''; };
      const rows = ch[0].standings.entries.map(e => ({
        rank: Number(num(e, 'rank')), name: e.team.shortDisplayName || e.team.displayName,
        logo: (e.team.logos || [])[0] ? e.team.logos[0].href : null,
        gp: num(e, 'gamesPlayed'), w: num(e, 'wins'), d: num(e, 'ties'), l: num(e, 'losses'), gd: num(e, 'pointDifferential'), pts: num(e, 'points'),
      })).sort((a, b) => a.rank - b.rank);
      standings.set(code, rows); cachePut('standings:' + code, rows);
    } catch (err) { console.error('Puan durumu alınamadı', code, err.message); }
  }));
  broadcast({ type: 'state', state: publicState() });
}
const enabledLeagues = () => CATALOG.filter(([code]) => (db.leagues || DEFAULT_LEAGUES).includes(code)).map(([code, label]) => [code, label]);
const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // YYYY-MM-DD
const hm = d => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
let autoMatches = cacheAge('matches') < 20 * MIN ? (cacheGet('matches') || []) : [];
const finalSeen = new Set();
let finalBaseline = false;
const prevScores = new Map();
async function refreshMatches() {
  const out = [];
  const today = ymd(new Date());
  // bugünün yerel saatle 00:00'ı (ms): yerel saat dizisini UTC gibi okuyup farkı al
  const nowMs = Date.now();
  const localNow = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(nowMs);
  const offsetMs = Math.round((Date.parse(localNow.replace(' ', 'T') + 'Z') - nowMs) / 60000) * 60000;
  const todayStart = Date.parse(today + 'T00:00:00Z') - offsetMs;
  const MATCH_MS = 2 * 3600 * 1000; // bir maçın yaklaşık süresi (devre arası dahil)
  // varsayılan skor tablosu (gece yarısını geçen canlı maçlar dahil) + bugün + yarın
  const queries = ['', '?dates=' + today.replace(/-/g, '')];
  for (const q of queries) {
    await Promise.all(enabledLeagues().map(async ([code, label]) => {
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard${q}`);
        const j = await r.json();
        for (const e of j.events || []) {
          const st = e.status.type.state;
          const when = new Date(e.date);
          // biten maç: bugün başladıysa ya da gece yarısını geçerek bittiyse göster; dünün eski sonuçlarını gösterme
          if (st === 'post' && when.getTime() < todayStart && when.getTime() + MATCH_MS <= todayStart) continue;
          if (st === 'pre' && ymd(when) !== today) continue; // yalnızca günlük: yarının maçları gösterilmez
          const c = e.competitions[0].competitors;
          const home = c.find(x => x.homeAway === 'home'), away = c.find(x => x.homeAway === 'away');
          const d = ymd(when);
          out.push({
            id: e.id, league: label, home: home.team.shortDisplayName || home.team.displayName,
            away: away.team.shortDisplayName || away.team.displayName,
            ts: when.getTime(), day: d >= today || st !== 'pre' ? (d > today ? 'Yarın' : 'Bugün') : 'Dün', time: hm(when),
            hl: home.team.logo || null, al: away.team.logo || null,
            live: st === 'in', final: st === 'post',
            hs: st === 'pre' ? null : home.score, as: st === 'pre' ? null : away.score,
            clock: st === 'in' ? e.status.displayClock : null,
            lastGoal: (() => {
              const g = (e.competitions[0].details || []).filter(d => d.scoringPlay).pop();
              if (!g) return null;
              return { min: g.clock && g.clock.displayValue, player: ((g.athletesInvolved || [])[0] || {}).displayName || '', own: !!g.ownGoal, pen: !!g.penaltyKick };
            })(),
          });
        }
      } catch (err) { console.error('Maç alınamadı', code, err.message); }
    }));
  }
  const seen = new Set();
  const rank = m => (m.live ? 0 : m.final ? 2 : 1);
  autoMatches = out.filter(m => !seen.has(m.id) && seen.add(m.id)).sort((a, b) => rank(a) - rank(b) || a.ts - b.ts);
  cachePut('matches', autoMatches);
  // yeni biten maç varsa o ligin puan durumunu birkaç dakika sonra yenile
  for (const m of autoMatches.filter(x => x.final)) {
    if (finalSeen.has(m.id)) continue;
    finalSeen.add(m.id);
    if (finalBaseline) {
      const c = CATALOG.find(([, label]) => label === m.league);
      if (c) { standingsDirty.add(c[0]); setTimeout(refreshStandings, 3 * MIN); setTimeout(refreshStandings, 15 * MIN); }
    }
  }
  finalBaseline = true;
  for (const m of autoMatches) {
    if (!m.live) continue;
    const cur = { h: +m.hs || 0, a: +m.as || 0 }, prev = prevScores.get(m.id);
    if (prev && (cur.h > prev.h || cur.a > prev.a)) {
      const g = m.lastGoal || {};
      broadcast({ type: 'goal', goal: {
        id: m.id, league: m.league, home: m.home, away: m.away, hs: m.hs, as: m.as,
        side: cur.h > prev.h ? 'home' : 'away', minute: g.min || m.clock, player: g.player || '', own: !!g.own, pen: !!g.pen,
      } });
    }
    prevScores.set(m.id, cur);
  }
  broadcast({ type: 'state', state: publicState() });
}
refreshStandings();
setInterval(refreshStandings, 20 * MIN); // kontrol sıklığı; ağa 6 saatte bir ya da bir maç bitince gidilir
(async function loop() {
  await refreshMatches();
  // sıklık: canlı maç varsa 25 sn; yakında başlayacak/yeni başlamış maç varsa 2 dk; değilse 10 dk
  const now = Date.now();
  const live = autoMatches.some(m => m.live);
  const soon = autoMatches.some(m => !m.live && !m.final && m.ts - now < 3 * HOUR && m.ts - now > -15 * MIN);
  setTimeout(loop, live ? 25 * 1000 : soon ? 2 * MIN : 10 * MIN);
})();


// ---- Tarihte bugün (Vikipedi Türkçe): günde bir kez, önbellekli ----
let onThisDay = cacheGet('onthisday');
async function refreshOnThisDay() {
  const today = ymd(new Date());
  if (onThisDay && onThisDay.date === today) return; // bugünün listesi elde
  const [, M, D] = today.split('-');
  try {
    const r = await fetch(`https://tr.wikipedia.org/api/rest_v1/feed/onthisday/events/${M}/${D}`, { headers: { accept: 'application/json', 'user-agent': 'BomeraTV/1.0 (cafe display)' } });
    const j = await r.json();
    const ev = (j.events || []).filter(e => e.year && e.text && e.text.length >= 30 && e.text.length <= 230).sort((a, b) => a.year - b.year);
    if (!ev.length) throw new Error('liste boş');
    const n = Math.min(6, ev.length), items = [];
    for (let i = 0; i < n; i++) items.push(ev[Math.floor(i * ev.length / n)]); // yıllara yayılmış 6 olay
    onThisDay = { date: today, items: items.map(e => ({ year: e.year, text: e.text })) };
    cachePut('onthisday', onThisDay);
    broadcast({ type: 'state', state: publicState() });
  } catch (e) { console.error('Tarihte bugün alınamadı:', e.message); }
}
setTimeout(refreshOnThisDay, 2000);
setInterval(refreshOnThisDay, 30 * MIN);

// ---- Nöbetçi eczaneler (CollectAPI, anahtar admin panelinden girilir): nöbet günü başına bir kez ----
const PHARM_BASE = process.env.PHARMACY_BASE || 'https://api.collectapi.com';
const dutyDay = () => ymd(new Date(Date.now() - 9 * HOUR)); // nöbet sabah 09:00'da değişir
let pharmacies = cacheGet('pharmacies');
let pharmError = '';
const pharmCfg = () => db.pharmacy || {};
const pharmSig = () => JSON.stringify([pharmCfg().il || 'İstanbul', pharmCfg().districts || []]);
// CollectAPI: istek sınırı ~16 sn'de bir, bu yüzden tüm çağrılar bu sıralayıcıdan geçer
const collectStats = { day: '', n: 0, lastError: '' };
let collectNext = 0;
async function collectFetch(url, key) {
  const t = Math.max(Date.now(), collectNext);
  collectNext = t + 17000;
  if (t > Date.now()) await new Promise(r => setTimeout(r, t - Date.now()));
  const day = ymd(new Date());
  if (collectStats.day !== day) { collectStats.day = day; collectStats.n = 0; }
  collectStats.n++;
  const r = await fetch(url, { headers: { authorization: 'apikey ' + key, 'content-type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 429) throw new Error('İstek sınırı aşıldı (429). Biraz sonra yeniden denenecek.');
  if (!r.ok || j.success === false) throw new Error(j.message || j.error || ('HTTP ' + r.status));
  return j;
}
async function fetchPharmacies(cfg) {
  const out = [];
  for (const d of cfg.districts) {
    const j = await collectFetch(`${PHARM_BASE}/health/dutyPharmacy?ilce=${encodeURIComponent(d)}&il=${encodeURIComponent(cfg.il || 'İstanbul')}`, cfg.key);
    for (const p of j.result || []) out.push({ district: p.dist || p.district || d, name: p.name || p.pharmacyName || '', address: p.address || '', phone: p.phone || '' });
  }
  return out;
}
async function refreshPharmacies(force) {
  const cfg = pharmCfg();
  if (!cfg.key || !(cfg.districts || []).length) { if (pharmacies) { pharmacies = null; broadcast({ type: 'state', state: publicState() }); } return; }
  const duty = dutyDay(), sig = pharmSig();
  if (!force && pharmacies && pharmacies.duty === duty && pharmacies.sig === sig) return; // bu nöbet günü için elde
  try {
    const items = await fetchPharmacies(cfg);
    pharmacies = { duty, sig, items, updated: new Date().toISOString() };
    pharmError = '';
    cachePut('pharmacies', pharmacies);
    broadcast({ type: 'state', state: publicState() });
  } catch (e) { pharmError = e.message; console.error('Nöbetçi eczane alınamadı:', e.message); }
}

// ---- Haberler (CollectAPI, Türkiye): ayarlanabilir aralıkta (varsayılan 3 saat), önbellekli ----
const newsCfg = () => db.news || {};
const newsKey = () => newsCfg().key || pharmCfg().key || ''; // ayrı anahtar girilmediyse eczane anahtarı kullanılır
let news = cacheGet('news');
let newsError = '', newsFailAt = 0;
async function fetchNews(key, tag) {
  const j = await collectFetch(`${PHARM_BASE}/news/getNews?country=tr&tag=${encodeURIComponent(tag || 'general')}`, key);
  const seen = new Set(), items = [];
  for (const n of j.result || []) {
    const title = String(n.name || '').trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    items.push({ title, source: n.source || '', date: n.date || null });
    if (items.length >= 8) break;
  }
  if (!items.length) throw new Error('haber listesi boş');
  return items;
}
async function refreshNews(force) {
  const cfg = newsCfg(), key = newsKey();
  if (!key || cfg.enabled === false) return;
  const ttl = Math.max(1, Math.min(12, Number(cfg.hours) || 3)) * HOUR;
  if (!force && news && news.tag === (cfg.tag || 'general') && cacheAge('news') < ttl) return; // taze
  if (!force && Date.now() - newsFailAt < 30 * MIN) return; // hata sonrası 30 dk bekle (kotayı yakma)
  try {
    const items = await fetchNews(key, cfg.tag || 'general');
    news = { tag: cfg.tag || 'general', items, updated: new Date().toISOString() };
    newsError = ''; cachePut('news', news);
    broadcast({ type: 'state', state: publicState() });
  } catch (e) { newsError = e.message; newsFailAt = Date.now(); console.error('Haber alınamadı:', e.message); }
}
setTimeout(refreshNews, 6000);
setInterval(refreshNews, 10 * MIN); // yalnızca süre dolunca ağa gider

setTimeout(refreshPharmacies, 4000);
setInterval(refreshPharmacies, 30 * MIN); // ağa yalnızca nöbet günü değişince ya da ayar değişince gidilir


// ---- Veritabanı yedekleri: günde bir (sabah 04:00'ten sonra), elle ve geri yüklemeden önce; son 30 tanesi tutulur ----
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const BACKUP_NAME = /^db-[A-Za-z0-9_.-]+\.json$/;
function listBackups() {
  return fs.readdirSync(BACKUP_DIR).filter(n => BACKUP_NAME.test(n)).map(n => {
    const st = fs.statSync(path.join(BACKUP_DIR, n));
    return { name: n, size: st.size, time: st.mtimeMs };
  }).sort((a, b) => b.time - a.time);
}
function backupNow(tag) {
  const now = new Date();
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace(':', '');
  const name = `db-${ymd(now)}_${hhmm}-${tag}.json`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(db, null, 2));
  for (const old of listBackups().slice(30)) fs.rmSync(path.join(BACKUP_DIR, old.name), { force: true }); // en yeni 30 kalsın
  return name;
}
function autoBackup() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()));
  const today = ymd(new Date());
  if (hour >= 4 && !listBackups().some(b => b.name.startsWith('db-' + today) && b.name.endsWith('-oto.json'))) {
    try { backupNow('oto'); } catch (e) { console.error('Yedek alınamadı:', e.message); }
  }
}
setTimeout(autoBackup, 8000);
setInterval(autoBackup, 30 * 60 * 1000);

// ---- Medya optimizasyonu (ffmpeg): videolar en fazla 1080p/30fps/6 Mbps H.264, sessiz, hızlı başlatmalı; fotoğraflar en fazla 1920 piksel ----
const { spawn } = require('child_process');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
let ffmpegOk = false;
try { const t = spawn(FFMPEG, ['-version'], { stdio: 'ignore' }); t.on('error', () => {}); t.on('close', c => { ffmpegOk = c === 0; }); } catch (e) { /* yok */ }
const optQueue = [];
let optBusy = false;
function runFfmpeg(args, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    try { require('os').setPriority(p.pid, 15); } catch (e) { /* öncelik düşürülemedi */ }
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-1500); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('ffmpeg ' + code + ': ' + err.trim().split('\n').slice(-2).join(' | '))); });
  });
}
const SCALE = "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
async function optimizeItem(id) {
  const v = db.videos.find(x => x.id === id);
  if (!v) return;
  const src = path.join(UPLOAD_DIR, v.file);
  const done = (patch) => { const c = db.videos.find(x => x.id === id); if (c) { Object.assign(c, { status: 'ready', reopt: false, optimized: true }, patch); changed(); } };
  if (!fs.existsSync(src)) return done({ optError: 'dosya bulunamadı' });
  const isImg = v.type === 'image';
  if (isImg && /\.(gif|svg)$/i.test(v.file)) return done({});
  const outName = uid() + (isImg ? '.jpg' : '.mp4'), out = path.join(UPLOAD_DIR, outName);
  const args = isImg
    ? ['-y', '-i', src, '-vf', SCALE, '-frames:v', '1', '-q:v', '3', out]
    : ['-y', '-i', src, '-vf', SCALE + ',fps=30,format=yuv420p', '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-preset', 'veryfast', '-crf', '23', '-maxrate', '6M', '-bufsize', '12M', '-an', '-movflags', '+faststart', '-threads', '2', out];
  const before = fs.statSync(src).size;
  try {
    await runFfmpeg(args);
    const after = fs.statSync(out).size;
    if (!db.videos.find(x => x.id === id)) { fs.rmSync(out, { force: true }); return; } // bu arada silinmiş
    if (after >= before && v.reopt) { fs.rmSync(out, { force: true }); return done({ sizeBefore: before, sizeAfter: before }); } // zaten küçükmüş
    fs.rmSync(src, { force: true });
    done({ file: outName, sizeBefore: before, sizeAfter: after, optError: '' });
  } catch (e) {
    fs.rmSync(out, { force: true });
    console.error('Optimizasyon başarısız:', v.name, e.message);
    done({ optError: String(e.message).slice(0, 200), optimized: false }); // orijinal dosya kullanılır
  }
}
function enqueueOpt(id) { if (!optQueue.includes(id)) optQueue.push(id); runOptQueue(); }
async function runOptQueue() {
  if (optBusy) return;
  optBusy = true;
  while (optQueue.length) { const id = optQueue.shift(); try { await optimizeItem(id); } catch (e) { console.error('Kuyruk hatası:', e.message); } }
  optBusy = false;
}
for (const v of db.videos) if (v.status === 'processing') enqueueOpt(v.id); // yarım kalanları sürdür

const app = express();
app.use(require('compression')()); // metin/JSON/HTML sıkıştırılır (videolar ve resimler zaten sıkışık, atlanır)
app.use(express.json());

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const [u, p] = Buffer.from(h.replace('Basic ', ''), 'base64').toString().split(':');
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Admin"').status(401).send('Giriş gerekli');
}
app.use(['/admin.html', '/admin', '/api/admin'], auth);
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

const publicState = () => ({
  videos: db.videos.filter(v => v.status !== 'processing' || v.reopt).map(v => ({ id: v.id, name: v.name, url: '/uploads/' + v.file, type: v.type || 'video' })),
  imageSeconds: db.imageSeconds,
  reviews: (db.reviews || []).filter(r => r.rating >= 4).map(({ id, author, rating, text }) => ({ id, author, rating, text })),
  matches: [
    ...db.matches.slice().sort((a, b) => a.time.localeCompare(b.time)).map(m => ({ ...m, day: 'Bugün' })),
    ...autoMatches.filter(m => enabledLeagues().some(([, label]) => label === m.league)),
  ].slice(0, 30).map(m => ({ ...m, channel: (db.channels || {})[`${m.league}|${m.home}|${m.away}`] || (db.leagueChannels || {})[m.league] || null })),
  showStandings: db.showStandings !== false,
  trafficApi: db.trafficApi || '',
  showQr: db.showQr !== false,
  fxMode: ['auto', 'lite', 'full'].includes(db.fxMode) ? db.fxMode : 'auto',
  showOnThisDay: db.showOnThisDay !== false,
  onThisDay: onThisDay && onThisDay.date === ymd(new Date()) ? onThisDay : null,
  showNews: newsCfg().enabled !== false,
  news: news && Date.now() - Date.parse(news.updated) < 12 * HOUR ? { items: news.items } : null, // 12 saatten eski haber gösterilmez
  showPharmacy: pharmCfg().enabled !== false,
  pharmacies: pharmacies && pharmacies.duty === dutyDay() && pharmacies.sig === pharmSig() ? { items: pharmacies.items, districts: pharmCfg().districts || [] } : null, // dünkü nöbet listesi gösterilmez
  safeInset: Math.max(0, Math.min(12, Number(db.safeInset) || 0)),
  safe: ['L', 'R', 'T', 'B'].reduce((o, k) => { const v = db['safe' + k]; o[k] = Math.max(0, Math.min(20, Number(v !== undefined && v !== null ? v : db.safeInset) || 0)); return o; }, {}),
  safeGuide: !!db.safeGuide,
  qrs: (db.qrs || []).map(({ id, label, svg, side }) => ({ id, label, svg, side: side === 'left' ? 'left' : 'right' })),
  standings: Object.fromEntries(enabledLeagues().filter(([code]) => standings.has(code)).map(([code, label]) => [label, standings.get(code)])),
  rates,
  weather,
  traffic,
});
app.get('/api/state', (_, res) => res.json(publicState()));
app.post('/api/traffic/report', (req, res) => {
  const { all, asia, europe, ts, sig } = req.body || {};
  if (![all, asia, europe, ts].every(n => typeof n === 'number' && isFinite(n)) || typeof sig !== 'string') return res.status(400).json({ error: 'eksik veri' });
  const exp = crypto.createHmac('sha256', trafficSecret()).update(`${all}|${asia}|${europe}|${ts}`).digest('hex');
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return res.status(403).json({ error: 'imza geçersiz' });
  if (Math.abs(Date.now() - ts) > 10 * 60 * 1000) return res.status(400).json({ error: 'veri çok eski' });
  if (!traffic || ts > traffic.at) {
    traffic = { all, asia, europe, source: 'ibb', at: ts, updated: new Date(ts).toISOString() };
    broadcast({ type: 'state', state: publicState() });
  }
  res.json({ ok: true });
});
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '365d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_, f, cb) => cb(null, uid() + path.extname(f.originalname)),
  }),
});

const changed = () => { save(); broadcast({ type: 'state', state: publicState() }); };

app.get('/api/admin/db', (_, res) => res.json(db));
app.get('/api/admin/leagues', (_, res) => res.json({
  catalog: CATALOG.map(([code, label, group]) => ({ code, label, group })),
  enabled: enabledLeagues().map(([code]) => code),
}));
function qrText(b) {
  if (b.kind === 'wifi') {
    if (!b.ssid) throw new Error('Ağ adı (SSID) gerekli');
    const esc = v => String(v).replace(/([\\;,:"])/g, '\\$1');
    const sec = ['WPA', 'WEP', 'nopass'].includes(b.security) ? b.security : 'WPA';
    return `WIFI:T:${sec};S:${esc(b.ssid)};${sec === 'nopass' ? '' : 'P:' + esc(b.password || '') + ';'};`;
  }
  const t = String(b.text || '').trim();
  if (!t) throw new Error('Link ya da metin gerekli');
  return /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t) && !/^https?:\/\//i.test(t) ? 'https://' + t : t;
}
app.post('/api/admin/qrs', async (req, res) => {
  try {
    const label = String(req.body.label || '').trim().slice(0, 40);
    if (!label) throw new Error('Etiket gerekli (örn. "Menü için okutun")');
    const text = qrText(req.body);
    if (text.length > 400) throw new Error('İçerik çok uzun');
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#14100c', light: '#ffffff' } });
    db.qrs = db.qrs || [];
    if (db.qrs.length >= 6) throw new Error('En fazla 6 QR kod eklenebilir');
    db.qrs.push({ id: uid(), label, kind: req.body.kind === 'wifi' ? 'wifi' : 'link', text, svg, side: req.body.side === 'left' ? 'left' : 'right' });
    changed(); res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/admin/qrs/:id', (req, res) => {
  const q = (db.qrs || []).find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'bulunamadı' });
  if (['left', 'right'].includes(req.body.side)) q.side = req.body.side;
  changed(); res.json({ ok: true });
});
app.delete('/api/admin/qrs/:id', (req, res) => {
  db.qrs = (db.qrs || []).filter(x => x.id !== req.params.id);
  changed(); res.json({ ok: true });
});
app.put('/api/admin/pharmacy', (req, res) => {
  const b = req.body || {}, cur = pharmCfg();
  const districts = Array.isArray(b.districts) ? b.districts.map(x => String(x).trim()).filter(Boolean).slice(0, 6) : cur.districts;
  db.pharmacy = {
    enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled !== false,
    key: typeof b.key === 'string' ? b.key.trim().slice(0, 120) : cur.key || '',
    il: typeof b.il === 'string' && b.il.trim() ? b.il.trim().slice(0, 40) : cur.il || 'İstanbul',
    districts,
  };
  changed(); res.json({ ok: true });
  refreshPharmacies(true);
});
app.post('/api/admin/pharmacy/test', async (req, res) => {
  const b = req.body || {}, cur = pharmCfg();
  const cfg = { key: (b.key || cur.key || '').trim(), il: (b.il || cur.il || 'İstanbul').trim(), districts: (Array.isArray(b.districts) && b.districts.length ? b.districts : cur.districts || []).map(x => String(x).trim()).filter(Boolean).slice(0, 6) };
  if (!cfg.key) return res.status(400).json({ error: 'Önce API anahtarını girin' });
  if (!cfg.districts.length) return res.status(400).json({ error: 'En az bir ilçe girin' });
  try { const items = await fetchPharmacies(cfg); res.json({ ok: true, count: items.length, sample: items.slice(0, 3) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.put('/api/admin/news', (req, res) => {
  const b = req.body || {}, cur = newsCfg();
  db.news = {
    enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled !== false,
    key: typeof b.key === 'string' ? b.key.trim().slice(0, 120) : cur.key || '',
    tag: ['general', 'economy', 'sport', 'technology'].includes(b.tag) ? b.tag : cur.tag || 'general',
    hours: [1, 2, 3, 6, 12].includes(Number(b.hours)) ? Number(b.hours) : cur.hours || 3,
  };
  newsFailAt = 0;
  changed(); res.json({ ok: true });
  refreshNews(true);
});
app.post('/api/admin/news/test', async (req, res) => {
  const b = req.body || {};
  const key = (b.key || newsKey() || '').trim();
  if (!key) return res.status(400).json({ error: 'Önce API anahtarını girin' });
  try { const items = await fetchNews(key, ['general', 'economy', 'sport', 'technology'].includes(b.tag) ? b.tag : 'general'); res.json({ ok: true, count: items.length, sample: items.slice(0, 2) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/admin/cache', (_, res) => {
  const age = k => (cache[k] ? Math.round((Date.now() - cache[k].at) / 60000) : null);
  res.json({
    hava: age('weather'), doviz: age('rates:fx'), altin: age('rates:gold'), maclar: age('matches'),
    tarihteBugun: onThisDay ? onThisDay.date : null,
    haber: news ? { adet: news.items.length, dk: age('news'), hata: newsError } : (newsError ? { hata: newsError } : null),
    collectBugun: collectStats.day === ymd(new Date()) ? collectStats.n : 0,
    nobetci: pharmacies ? { duty: pharmacies.duty, adet: pharmacies.items.length, guncel: pharmacies.duty === dutyDay() } : null, nobetciHata: pharmError,
    puanDurumu: Object.fromEntries([...standings.keys()].map(c => [c, age('standings:' + c)])),
  });
});
app.post('/api/admin/media/optimize-all', (_, res) => {
  let n = 0;
  for (const v of db.videos) if (!v.optimized && v.status !== 'processing') { v.status = 'processing'; v.reopt = true; enqueueOpt(v.id); n++; }
  changed(); res.json({ ok: true, count: n });
});
app.get('/api/admin/system', (_, res) => res.json({ ffmpeg: ffmpegOk, queue: optQueue.length + (optBusy ? 1 : 0) }));
app.get('/api/admin/backups', (_, res) => res.json(listBackups()));
app.post('/api/admin/backups', (_, res) => { try { res.json({ ok: true, name: backupNow('manuel') }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/admin/backups/:name/download', (req, res) => {
  if (!BACKUP_NAME.test(req.params.name)) return res.status(400).send('geçersiz ad');
  res.download(path.join(BACKUP_DIR, req.params.name));
});
app.post('/api/admin/backups/:name/restore', (req, res) => {
  if (!BACKUP_NAME.test(req.params.name)) return res.status(400).json({ error: 'geçersiz ad' });
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, req.params.name), 'utf8'));
    if (!parsed || !Array.isArray(parsed.videos)) throw new Error('yedek dosyası geçerli değil');
    backupNow('geri-yukleme-oncesi');
    db = { ...db, ...parsed };
    const missing = db.videos.filter(v => !fs.existsSync(path.join(UPLOAD_DIR, v.file))).length;
    changed();
    res.json({ ok: true, missingFiles: missing });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/admin/options', (req, res) => {
  if (typeof req.body.showStandings === 'boolean') db.showStandings = req.body.showStandings;
  if (typeof req.body.showQr === 'boolean') db.showQr = req.body.showQr;
  if (typeof req.body.showOnThisDay === 'boolean') db.showOnThisDay = req.body.showOnThisDay;
  if (['auto', 'lite', 'full'].includes(req.body.fxMode)) db.fxMode = req.body.fxMode;
  if (req.body.safeInset !== undefined && isFinite(Number(req.body.safeInset))) db.safeInset = Math.max(0, Math.min(12, Math.round(Number(req.body.safeInset) * 2) / 2));
  for (const k of ['L', 'R', 'T', 'B']) {
    const v = req.body['safe' + k];
    if (v !== undefined && isFinite(Number(v))) db['safe' + k] = Math.max(0, Math.min(20, Math.round(Number(v) * 2) / 2));
  }
  if (typeof req.body.safeGuide === 'boolean') db.safeGuide = req.body.safeGuide;
  if (typeof req.body.trafficApi === 'string') {
    const u = req.body.trafficApi.trim();
    if (u && !/^https:\/\/[^\s]+$/.test(u)) return res.status(400).json({ error: 'Adres https:// ile başlamalı' });
    db.trafficApi = u;
  }
  changed(); res.json({ ok: true });
});
app.get('/api/admin/traffic/status', (_, res) => res.json({ current: traffic, secret: trafficSecret() }));
app.put('/api/admin/channels/league', (req, res) => {
  const { league, channel } = req.body;
  if (!league) return res.status(400).json({ error: 'lig gerekli' });
  db.leagueChannels = db.leagueChannels || {};
  const v = String(channel || '').trim().slice(0, 40);
  if (v) db.leagueChannels[league] = v; else delete db.leagueChannels[league];
  changed(); res.json({ ok: true });
});
app.put('/api/admin/channels/match', (req, res) => {
  const { key, channel } = req.body;
  if (!key) return res.status(400).json({ error: 'maç gerekli' });
  db.channels = db.channels || {};
  const v = String(channel || '').trim().slice(0, 40);
  if (v) db.channels[key] = v; else delete db.channels[key];
  changed(); res.json({ ok: true });
});
app.put('/api/admin/leagues', (req, res) => {
  const valid = new Set(CATALOG.map(([code]) => code));
  db.leagues = (req.body.enabled || []).filter(c => valid.has(c));
  changed(); res.json({ ok: true });
  refreshMatches(); refreshStandings();
});
app.post('/api/admin/videos', upload.array('files'), (req, res) => {
  for (const f of req.files) {
    const rec = { id: uid(), file: f.filename, name: f.originalname, type: f.mimetype.startsWith('image/') ? 'image' : 'video', status: 'processing' };
    db.videos.push(rec);
    enqueueOpt(rec.id); // yeni yükleme optimize edilene kadar ekranda gösterilmez
  }
  changed(); res.json({ ok: true });
});
app.delete('/api/admin/videos/:id', (req, res) => {
  const v = db.videos.find(x => x.id === req.params.id);
  if (v) fs.rm(path.join(UPLOAD_DIR, v.file), () => {});
  db.videos = db.videos.filter(x => x.id !== req.params.id);
  changed(); res.json({ ok: true });
});
app.post('/api/admin/videos/:id/move', (req, res) => {
  const i = db.videos.findIndex(x => x.id === req.params.id);
  const j = i + (req.body.dir === 'up' ? -1 : 1);
  if (i >= 0 && j >= 0 && j < db.videos.length) [db.videos[i], db.videos[j]] = [db.videos[j], db.videos[i]];
  changed(); res.json({ ok: true });
});
app.put('/api/admin/settings', (req, res) => {
  db.imageSeconds = Math.max(3, Number(req.body.imageSeconds) || 10);
  changed(); res.json({ ok: true });
});
app.post('/api/admin/reviews', (req, res) => {
  const { author, rating, text } = req.body;
  const n = Number(rating);
  if (!author || !text || ![4, 5].includes(n)) return res.status(400).json({ error: 'isim, metin ve 4 veya 5 yıldız gerekli' });
  db.reviews.push({ id: uid(), author: String(author).slice(0, 60), rating: n, text: String(text).slice(0, 400) });
  changed(); res.json({ ok: true });
});
app.delete('/api/admin/reviews/:id', (req, res) => {
  db.reviews = db.reviews.filter(x => x.id !== req.params.id);
  changed(); res.json({ ok: true });
});
app.post('/api/admin/matches', (req, res) => {
  const { home, away, time, league } = req.body;
  if (!home || !away || !time) return res.status(400).json({ error: 'eksik alan' });
  db.matches.push({ id: uid(), home, away, time, league: league || '' });
  changed(); res.json({ ok: true });
});
app.delete('/api/admin/matches/:id', (req, res) => {
  db.matches = db.matches.filter(x => x.id !== req.params.id);
  changed(); res.json({ ok: true });
});
app.post('/api/admin/birthdays', (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'isim gerekli' });
  db.birthdays.push({ id: uid(), name: req.body.name, selected: true });
  save(); res.json({ ok: true });
});
app.patch('/api/admin/birthdays/:id', (req, res) => {
  const b = db.birthdays.find(x => x.id === req.params.id);
  if (b) b.selected = !!req.body.selected;
  save(); res.json({ ok: true });
});
app.delete('/api/admin/birthdays/:id', (req, res) => {
  db.birthdays = db.birthdays.filter(x => x.id !== req.params.id);
  save(); res.json({ ok: true });
});
app.put('/api/admin/schedule', (req, res) => {
  db.times = (req.body.times || []).filter(t => /^\d{2}:\d{2}$/.test(t));
  db.duration = Math.max(5, Number(req.body.duration) || 40);
  save(); res.json({ ok: true });
});
app.post('/api/admin/goal/test', (_, res) => {
  broadcast({ type: 'goal', goal: { id: 'test', league: 'La Liga', home: 'Barcelona', away: 'Real Madrid', hs: 1, as: 2, side: 'away', minute: "67'", player: 'Kylian Mbappé', own: false, pen: false } });
  res.json({ ok: true });
});
app.post('/api/admin/birthday/fire', (_, res) => { fireBirthday(); res.json({ ok: true }); });

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: { threshold: 1024 } });
function broadcast(msg) {
  const s = JSON.stringify(msg);
  wss.clients.forEach(c => c.readyState === 1 && c.send(s));
}
const BUILD = require('crypto').createHash('md5').update(fs.readFileSync(path.join(__dirname, 'public/index.html'))).digest('hex');
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'version', build: BUILD }));
  ws.send(JSON.stringify({ type: 'state', state: publicState() }));
});

function fireBirthday() {
  const names = db.birthdays.filter(b => b.selected).map(b => b.name);
  if (names.length) broadcast({ type: 'birthday', names, duration: db.duration });
}
let lastFired = '';
setInterval(() => {
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  if (db.times.includes(now) && lastFired !== now) { lastFired = now; fireBirthday(); }
}, 15000);

server.listen(PORT, () => console.log('Port', PORT));
