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

let db = { videos: [], matches: [], birthdays: [], times: ['13:00', '19:00'], duration: 40, imageSeconds: 10, reviews: [], leagues: null, channels: {}, leagueChannels: {}, showStandings: true, trafficApi: '', trafficSecret: '', qrs: [], showQr: true, fxMode: 'auto', safeInset: 0, safeGuide: false, showOnThisDay: true, pharmacy: { enabled: true, key: '', il: 'İstanbul', districts: [] }, news: { enabled: true, key: '', tag: 'general', hours: 3 }, movies: { enabled: true, key: '', trailers: true }, bigMatch: { enabled: true, note: 'Rezervasyon yaptırmayı unutmayın!', days: 3, everyMin: 6, durSec: 15 } };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
(db.birthdays || []).forEach(b => { if (typeof b.text !== 'string') b.text = '🎉 Doğum günün kutlu olsun ' + b.name + '! 🎂'; }); // eski kayıtlar: yazı artık elle düzenlenir
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
        at: Date.now(), id: m.id, league: m.league, home: m.home, away: m.away, hs: m.hs, as: m.as,
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
let pharmError = '', pharmFailAt = 0;
const pharmCfg = () => db.pharmacy || {};
const pharmSig = () => JSON.stringify([pharmCfg().il || 'İstanbul', pharmCfg().districts || []]);
// CollectAPI: istek sınırı ~16 sn'de bir, bu yüzden tüm çağrılar bu sıralayıcıdan geçer
const collectStats = { day: '', n: 0, lastError: '' };
// Ücretsiz plan aylık kotaları (güvenlik payıyla): eczane 100, haber 1000
const QUOTA = { pharm: { limit: 100, cap: 92 }, news: { limit: 1000, cap: 960 }, books: { limit: 1000, cap: 150 } };
const monthKey = () => ymd(new Date()).slice(0, 7);
let quota = cacheGet('quota') || {};
if (quota.month !== monthKey()) quota = { month: monthKey(), pharm: 0, news: 0, books: 0 };
const quotaLeft = svc => QUOTA[svc].cap - (quota.month === monthKey() ? quota[svc] || 0 : 0);
let collectNext = 0;
async function collectFetch(url, key, svc) {
  if (quota.month !== monthKey()) quota = { month: monthKey(), pharm: 0, news: 0, books: 0 };
  if (svc && quotaLeft(svc) <= 0) throw new Error(`Aylık ücretsiz kota doldu (${svc === 'pharm' ? 'eczane' : 'haber'}: ${quota[svc]}/${QUOTA[svc].limit}). Ay başında sıfırlanır.`);
  if (svc) { quota[svc] = (quota[svc] || 0) + 1; cachePut('quota', quota); }
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
    const j = await collectFetch(`${PHARM_BASE}/health/dutyPharmacy?ilce=${encodeURIComponent(d)}&il=${encodeURIComponent(cfg.il || 'İstanbul')}`, cfg.key, 'pharm');
    for (const p of j.result || []) out.push({ district: p.dist || p.district || d, name: p.name || p.pharmacyName || '', address: p.address || '', phone: p.phone || '' });
  }
  return out;
}
async function refreshPharmacies(force) {
  const cfg = pharmCfg();
  if (!cfg.key || !(cfg.districts || []).length) { if (pharmacies) { pharmacies = null; broadcast({ type: 'state', state: publicState() }); } return; }
  const duty = dutyDay(), sig = pharmSig();
  if (!force && pharmacies && pharmacies.duty === duty && pharmacies.sig === sig && pharmacies.items.length) return; // bu nöbet günü için elde (boş liste sayılmaz)
  if (!force && Date.now() - pharmFailAt < 3 * HOUR) return; // hata/boş sonrası 3 saat bekle (kotayı yakma)
  try {
    const items = await fetchPharmacies(cfg);
    if (!items.length) throw new Error('Servis boş liste döndürdü, yeniden denenecek');
    pharmacies = { duty, sig, items, updated: new Date().toISOString() };
    pharmError = '';
    cachePut('pharmacies', pharmacies);
    broadcast({ type: 'state', state: publicState() });
  } catch (e) { pharmError = e.message; pharmFailAt = Date.now(); console.error('Nöbetçi eczane alınamadı:', e.message); }
}

// ---- Haberler (CollectAPI, Türkiye): ayarlanabilir aralıkta (varsayılan 3 saat), önbellekli ----
const newsCfg = () => db.news || {};
const newsKey = () => newsCfg().key || pharmCfg().key || ''; // ayrı anahtar girilmediyse eczane anahtarı kullanılır
let news = cacheGet('news');
let newsError = '', newsFailAt = 0;
async function fetchNews(key, tag) {
  const j = await collectFetch(`${PHARM_BASE}/news/getNews?country=tr&tag=${encodeURIComponent(tag || 'general')}`, key, 'news');
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
  if (!force && Date.now() - newsFailAt < 60 * MIN) return; // hata sonrası 1 saat bekle (kotayı yakma)
  try {
    const items = await fetchNews(key, cfg.tag || 'general');
    news = { tag: cfg.tag || 'general', items, updated: new Date().toISOString() };
    newsError = ''; cachePut('news', news);
    broadcast({ type: 'state', state: publicState() });
  } catch (e) { newsError = e.message; newsFailAt = Date.now(); console.error('Haber alınamadı:', e.message); }
}
// ---- Yeni çıkan kitaplar (CollectAPI /book/newBook): günde bir kez ----
let books = cacheGet('books');
let booksError = '', booksFailAt = 0;
async function refreshBooks(force) {
  const key = newsKey();
  if (!key || db.showBooks === false) return;
  if (!force && books && cacheAge('books') < 24 * HOUR) return;
  if (!force && Date.now() - booksFailAt < 3 * HOUR) return;
  try {
    const j = await collectFetch(`${PHARM_BASE}/book/newBook`, key, 'books');
    const seen = new Set(), items = [];
    for (const b of j.result || []) {
      const title = String(b.title || '').trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      items.push({ title, author: String(b.yazar || '').trim(), publisher: String(b['yayın'] || b.yayin || '').trim(), price: String(b.indirim || b.fiyat || '').trim(), oldPrice: b.fiyat && b.indirim && b.fiyat !== b.indirim ? String(b.fiyat).trim() : '' });
      if (items.length >= 8) break;
    }
    if (!items.length) throw new Error('kitap listesi boş');
    books = { items, updated: new Date().toISOString() };
    booksError = ''; cachePut('books', books);
    broadcast({ type: 'state', state: publicState() });
  } catch (e) { booksError = e.message; booksFailAt = Date.now(); console.error('Kitaplar alınamadı:', e.message); }
}
setTimeout(refreshBooks, 9000);
setInterval(refreshBooks, 30 * MIN);


// ---- Türkiye sinemalarında şu an gösterilen filmler ve fragmanları (TMDB, ücretsiz anahtar admin panelinden girilir): günde bir kez ----
const movieCfg = () => db.movies || {};
let movies = cacheGet('movies');
let moviesError = '', moviesFailAt = 0;
const TMDB = 'https://api.themoviedb.org/3';
async function tmdb(p, key) {
  const r = await fetch(`${TMDB}${p}${p.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`, { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.status_message || ('HTTP ' + r.status));
  return j;
}
async function fetchMovies(key) {
  // Türkiye'de vizyon günü cuma: son 3 haftada ve bu hafta sinemalara çıkmış filmler (yalnızca sinema gösterimi, dijital platform yok)
  const now = new Date(), dow = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(now);
  const back = { Fri: 0, Sat: 1, Sun: 2, Mon: 3, Tue: 4, Wed: 5, Thu: 6 }[dow];
  const from = ymd(new Date(now.getTime() - (back + 14) * 24 * HOUR)), to = ymd(new Date(now.getTime() + (6 - back) * 24 * HOUR));
  const j = await tmdb(`/discover/movie?region=TR&with_release_type=3&release_date.gte=${from}&release_date.lte=${to}&language=tr-TR&sort_by=popularity.desc&include_adult=false`, key);
  const items = [];
  for (const m of (j.results || []).slice(0, 10)) {
    let trailer = '', alts = [];
    try {
      const cand = [];
      for (const lang of ['tr-TR', 'en-US']) {
        const v = await tmdb(`/movie/${m.id}/videos?language=${lang}`, key);
        for (const t of (v.results || []).filter(x => x.site === 'YouTube' && (x.type === 'Trailer' || x.type === 'Teaser')).sort((x, y) => (y.type === 'Trailer') - (x.type === 'Trailer') || (y.official === true) - (x.official === true)))
          if (!cand.includes(t.key)) cand.push(t.key);
      }
      for (const k of cand.slice(0, 6)) { // gömülmesine izin vermeyen videolar (oEmbed 401/403) atlanır
        try { const o = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + k)}`); if (!o.ok) continue; } catch (e) { /* ağ hatası: yine de dene */ }
        alts.push(k); if (alts.length >= 3) break;
      }
      trailer = alts[0] || '';
    } catch (e) { /* fragmansız kalır */ }
    items.push({ id: m.id, title: m.title, original: m.original_title !== m.title ? m.original_title : '', date: m.release_date || '', rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : 0, poster: m.poster_path ? 'https://image.tmdb.org/t/p/w185' + m.poster_path : '', trailer, alts });
  }
  if (!items.length) throw new Error('bu hafta için vizyon listesi boş');
  return { from, to, items };
}
async function refreshMovies(force) {
  const cfg = movieCfg();
  if (!cfg.key || cfg.enabled === false) return;
  if (!force && movies && cacheAge('movies') < 12 * HOUR) return;
  if (!force && Date.now() - moviesFailAt < 3 * HOUR) return;
  try {
    const r = await fetchMovies(cfg.key);
    movies = { ...r, updated: new Date().toISOString() };
    moviesError = ''; cachePut('movies', movies);
    broadcast({ type: 'state', state: publicState() });
  } catch (e) { moviesError = e.message; moviesFailAt = Date.now(); console.error('Filmler alınamadı:', e.message); }
}
setTimeout(refreshMovies, 11000);
setInterval(refreshMovies, 30 * MIN);

setTimeout(refreshNews, 6000);
setInterval(refreshNews, 10 * MIN); // yalnızca süre dolunca ağa gider

setTimeout(refreshPharmacies, 4000);
setInterval(refreshPharmacies, 30 * MIN); // ağa yalnızca nöbet günü değişince ya da ayar değişince gidilir


// ---- Büyük maç duyurusu: 4 büyüklerin derbileri ve Avrupa kupası maçları, başlamadan en çok N gün önce ekranda görsel olarak çıkar ----
const bigCfg = () => ({ enabled: true, note: 'Rezervasyon yaptırmayı unutmayın!', days: 3, everyMin: 6, durSec: 15, ...(db.bigMatch || {}) });
const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').toLowerCase();
const isBig4 = name => ['galatasaray', 'fenerbahce', 'besiktas', 'trabzonspor'].some(k => norm(name).includes(k));
const BIG_LEAGUES = [['tur.1', 'Süper Lig'], ['uefa.champions', 'Şampiyonlar Ligi'], ['uefa.europa', 'Avrupa Ligi'], ['uefa.europa.conf', 'Konferans Ligi'], ['uefa.champions_qual', 'Şampiyonlar Ligi Eleme']];
let bigMatches = cacheGet('bigmatches') || [];
let bigError = '';
async function refreshBigMatches() {
  const out = [], now = Date.now(), days = Math.max(1, Math.min(7, Number(bigCfg().days) || 3));
  const dates = Array.from({ length: days + 1 }, (_, i) => ymd(new Date(now + i * 24 * HOUR)).replace(/-/g, '')); // ESPN aralık sorgusunu desteklemiyor: gün gün
  let ok = 0;
  for (const [code, label] of BIG_LEAGUES) {
    for (const dt of dates) try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard?dates=${dt}`);
      const j = await r.json();
      ok++;
      for (const e of j.events || []) {
        if (e.status.type.state !== 'pre') continue;
        const c = e.competitions[0].competitors;
        const home = c.find(x => x.homeAway === 'home'), away = c.find(x => x.homeAway === 'away');
        if (!home || !away) continue;
        const hb = isBig4(home.team.displayName), ab = isBig4(away.team.displayName);
        const derby = code === 'tur.1' && hb && ab;
        if (!derby && (code === 'tur.1' || !(hb || ab))) continue; // ligde yalnızca derbi, Avrupa'da 4 büyükten biri
        out.push({ id: e.id, league: label, home: home.team.shortDisplayName || home.team.displayName, away: away.team.shortDisplayName || away.team.displayName, ts: new Date(e.date).getTime(), hl: home.team.logo || null, al: away.team.logo || null, derby });
      }
    } catch (err) { bigError = err.message; console.error('Büyük maç alınamadı', code, err.message); }
  }
  if (!ok) return;
  bigError = '';
  const seen = new Set();
  bigMatches = out.filter(m => !seen.has(m.id) && seen.add(m.id)).sort((a, b) => a.ts - b.ts);
  cachePut('bigmatches', bigMatches);
  broadcast({ type: 'state', state: publicState() });
}
const activeBig = () => { const now = Date.now(), lim = Math.max(1, Math.min(7, Number(bigCfg().days) || 3)) * 24 * HOUR; return bigMatches.filter(m => m.ts > now && m.ts - now <= lim).map(m => ({ ...m, hl: localLogo(m.hl), al: localLogo(m.al) })); };
setTimeout(refreshBigMatches, 7000);
setInterval(refreshBigMatches, 30 * MIN);
setInterval(() => { const sig = activeBig().map(m => m.id).join(); if (sig !== (global.__bigSig || '')) { global.__bigSig = sig; broadcast({ type: 'state', state: publicState() }); } }, MIN);


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
function runCmd(cmd, args, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    try { require('os').setPriority(p.pid, 15); } catch (e) { /* öncelik düşürülemedi */ }
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-1500); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(path.basename(cmd) + ' ' + code + ': ' + err.trim().split('\n').slice(-2).join(' | '))); });
  });
}
const runFfmpeg = (args, timeoutMs) => runCmd(FFMPEG, ['-nostdin', ...args], timeoutMs);
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

// ---- Resmî gün kutlamaları: gün başından ertesi gün 03:00'e kadar üstte bayrak + Atatürk sözleri, arada fotoğraflar ----
const HOLIDAYS = [
  { id: 'nisan23', photoPrefix: 'nisan23-', md: '04-23', title: '23 Nisan Ulusal Egemenlik ve Çocuk Bayramı', quotes: [
    'Egemenlik kayıtsız şartsız milletindir.',
    'Çocuklar geleceğimizin güvencesi, yaşatıcısıdır.',
    'Küçük hanımlar, küçük beyler! Sizler hepiniz geleceğin bir gül bahçesinin gülleri, yıldızları, ışıklarısınız.',
    'Yurtta sulh, cihanda sulh.'] },
  { id: 'mayis19', photoPrefix: 'mayis19-', md: '05-19', title: "19 Mayıs Atatürk'ü Anma, Gençlik ve Spor Bayramı", quotes: [
    'Bütün ümidim gençliktedir.',
    'Ey Türk gençliği! Birinci vazifen, Türk istiklalini, Türk Cumhuriyetini ilelebet muhafaza ve müdafaa etmektir.',
    'Hayatta en hakiki mürşit ilimdir.',
    'Ne mutlu Türk\'üm diyene!'] },
  { id: 'agustos30', photoPrefix: 'agustos30-', md: '08-30', title: '30 Ağustos Zafer Bayramı', quotes: [
    'Hatt-ı müdafaa yoktur, sath-ı müdafaa vardır. O satıh bütün vatandır.',
    'Ordular! İlk hedefiniz Akdeniz\'dir, ileri!',
    'Yurtta sulh, cihanda sulh.',
    'Ne mutlu Türk\'üm diyene!'] },
  { id: 'ekim29', md: '10-29', photoPrefix: 'cumhuriyet-', title: '29 Ekim Cumhuriyet Bayramı', quotes: [
    'Ne mutlu Türk\'üm diyene!',
    'Cumhuriyeti biz kurduk, onu yükseltecek ve yaşatacak sizsiniz.',
    'Benim naçiz vücudum elbet bir gün toprak olacaktır, fakat Türkiye Cumhuriyeti ilelebet payidar kalacaktır.',
    'Egemenlik kayıtsız şartsız milletindir.',
    'Yurtta sulh, cihanda sulh.'] },
  { id: 'kasim10', md: '11-10', photoPrefix: 'anma-', mourn: true, silence: '09:05', title: "10 Kasım Atatürk'ü Anma Günü", quotes: [
    'Benim naçiz vücudum elbet bir gün toprak olacaktır, fakat Türkiye Cumhuriyeti ilelebet payidar kalacaktır.',
    'Hayatta en hakiki mürşit ilimdir.',
    'Ben, manevi miras olarak hiçbir ayet, hiçbir dogma, hiçbir donmuş ve kalıplaşmış kural bırakmıyorum. Benim manevi mirasım ilim ve akıldır.',
    'Yurtta sulh, cihanda sulh.'] },
];
const CELEB_DIR = path.join(__dirname, 'public/celebrate');
// bir günün fotoğrafları: hazır olanlar (her gün için) + o güne admin'den eklenenler
const celebPhotos = h => [
  ...(h.photoPrefix && fs.existsSync(CELEB_DIR) ? fs.readdirSync(CELEB_DIR).filter(f => /\.(jpe?g|png|webp)$/i.test(f) && f.startsWith(h.photoPrefix)).sort().map(f => ({ url: '/celebrate/' + f })) : []),
  ...(db.celebPhotos || []).filter(p => p.day === h.id).map(p => ({ id: p.id, url: '/uploads/' + p.file })),
];
(db.celebPhotos || []).forEach(p => { if (!p.day) p.day = p.mourn ? 'kasim10' : 'ekim29'; }); // eski kayıtlar
// gün başına mod: auto (tarihe göre), on (elle açık), off (kapalı)
const celebMode = id => ((db.celebMode || {})[id]) || 'auto';
function activeCelebration() {
  if (db.showCelebrations === false) return null;
  let h = null, until = 0;
  if (db.celebPreview && db.celebPreviewUntil > Date.now()) { h = HOLIDAYS.find(x => x.id === db.celebPreview); until = db.celebPreviewUntil; }
  if (!h) { h = HOLIDAYS.find(x => celebMode(x.id) === 'on'); if (h) until = Date.now() + 30 * 24 * HOUR; }
  if (!h) {
    const today = ymd(new Date()).slice(5), early = ymd(new Date(Date.now() - 3 * HOUR)).slice(5); // 03:00'e kadar önceki günün kutlaması sürer
    h = HOLIDAYS.find(x => celebMode(x.id) === 'auto' && (x.md === today || x.md === early));
    if (h) {
      const [y, m, d] = ymd(new Date(Date.now() - (h.md === today ? 0 : 3 * HOUR))).split('-').map(Number);
      until = Date.UTC(y, m - 1, d + 1, 0, 0, 0); // bitiş: ertesi gün 03:00 İstanbul (UTC+3 sabit) = ertesi gün 00:00 UTC
    }
  }
  return h ? { id: h.id, title: h.title, quotes: h.quotes, mourn: !!h.mourn, silence: h.silence || null, photos: celebPhotos(h).map(x => x.url), until } : null;
}
let lastCeleb = null;
setInterval(() => { const a = activeCelebration(), k = a ? a.id : null; if (k !== lastCeleb) { lastCeleb = k; broadcast({ type: 'state', state: publicState() }); } }, 30 * 1000);

// ---- Kampanyalar: ekranda belirli aralıklarla tam kadraj çıkan duyuru kartları (QR kodlu) ----
const CAMP_QR = url => QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#14100c', light: '#ffffff' } });
if (!Array.isArray(db.campaigns) || !db.campaigns.length) db.campaigns = [{
  id: 'google-yorum', kind: 'review', enabled: true,
  url: 'https://g.page/r/CThl3eBpiSY5EAE/review',
  headline: 'Yorumunuz bizim için çok değerli!',
  sub: 'İlk yorumunuzda istediğiniz sıcak içecek ikramımızdır ☕',
  note: 'Not: Yorum yaptıktan sonra lütfen bir yetkiliye haber verin.',
  qrLabel: "Google'da bizi değerlendirin",
  everyMin: 3, durSec: 15,
}];
(async () => { let ch = false; for (const c of db.campaigns) if (!c.svg && c.url) { try { c.svg = await CAMP_QR(c.url); ch = true; } catch {} } if (ch) save(); })();
const pubCamp = ({ id, headline, sub, note, qrLabel, svg, everyMin, durSec }) => ({ id, headline, sub, note, qrLabel, svg, everyMin, durSec });
const publicCampaigns = () => db.campaigns.filter(c => c.enabled && c.svg).map(pubCamp);

// public/apk-version.json: yeni APK yayınlanınca sürüm kodu burada artırılır; Android uygulaması kendi sürümüyle karşılaştırıp güncelleme bildirimi gösterir
const appVersion = () => { try { const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'public/apk-version.json'), 'utf8')); return { versionCode: Number(v.versionCode) || 0, versionName: String(v.versionName || ''), url: '/BomeraTV.apk' }; } catch { return null; } };
const publicState = () => ({
  videos: db.videos.filter(v => v.status !== 'processing' || v.reopt).map(v => ({ id: v.id, name: v.name, url: '/uploads/' + v.file, type: v.type || 'video' })),
  imageSeconds: db.imageSeconds,
  reviews: (db.reviews || []).filter(r => r.rating >= 4).map(({ id, author, rating, text }) => ({ id, author, rating, text })),
  matches: [
    ...db.matches.slice().sort((a, b) => a.time.localeCompare(b.time)).map(m => ({ ...m, day: 'Bugün' })),
    ...autoMatches.filter(m => enabledLeagues().some(([, label]) => label === m.league)),
  ].slice(0, 30).map(m => ({ ...m, hl: localLogo(m.hl), al: localLogo(m.al) })),
  showStandings: db.showStandings !== false,
  trafficApi: db.trafficApi || '',
  mapAt: mapAt ? Math.round(mapAt) : null,
  showQr: db.showQr !== false,
  fxMode: ['auto', 'lite', 'full'].includes(db.fxMode) ? db.fxMode : 'auto',
  showOnThisDay: db.showOnThisDay !== false,
  onThisDay: onThisDay && onThisDay.date === ymd(new Date()) ? onThisDay : null,
  showNews: newsCfg().enabled !== false,
  showBooks: db.showBooks !== false,
  bigMatches: bigCfg().enabled ? activeBig() : [],
  bigCfg: { note: bigCfg().note, everyMin: bigCfg().everyMin, durSec: bigCfg().durSec },
  showMovies: movieCfg().enabled !== false,
  showTrailers: movieCfg().trailers !== false,
  movies: movies && movies.items && Date.now() - Date.parse(movies.updated) < 4 * 24 * HOUR ? { items: movies.items } : null,
  celebration: activeCelebration(),
  app: appVersion(),
  campaigns: publicCampaigns(),
  books: books && Date.now() - Date.parse(books.updated) < 72 * HOUR ? { items: books.items } : null,
  news: news && Date.now() - Date.parse(news.updated) < 12 * HOUR ? { items: news.items } : null, // 12 saatten eski haber gösterilmez
  showPharmacy: pharmCfg().enabled !== false,
  pharmacies: pharmacies && pharmacies.duty === dutyDay() && pharmacies.sig === pharmSig() ? { items: pharmacies.items, districts: pharmCfg().districts || [] } : null, // dünkü nöbet listesi gösterilmez
  safeInset: Math.max(0, Math.min(12, Number(db.safeInset) || 0)),
  safe: ['L', 'R', 'T', 'B'].reduce((o, k) => { const v = db['safe' + k]; o[k] = Math.max(0, Math.min(20, Number(v !== undefined && v !== null ? v : db.safeInset) || 0)); return o; }, {}),
  safeGuide: !!db.safeGuide,
  qrs: (db.qrs || []).map(({ id, label, svg, side }) => ({ id, label, svg, side: side === 'left' ? 'left' : 'right' })),
  standings: Object.fromEntries(enabledLeagues().filter(([code]) => standings.has(code) && !(db.hideTables || []).includes(code)).map(([code, label]) => [label, standings.get(code).map(r => ({ ...r, logo: localLogo(r.logo) }))])),
  rates,
  weather,
  traffic,
});


// ---- Trafik haritası: sunucuda (başsız Chromium) çizilir, koyu temaya çevrilip resim olarak saklanır; TV yalnızca resmi gösterir ----
const MAP_DIR = path.join(DATA_DIR, 'map');
fs.mkdirSync(MAP_DIR, { recursive: true });
const MAP_FILE = path.join(MAP_DIR, 'traffic.jpg');
const CHROMIUM = process.env.CHROMIUM_PATH || 'chromium';
const MAP_URL = 'https://yandex.com.tr/map-widget/v1/?ll=28.95%2C41.04&z=11&l=map%2Ctrf&lang=tr_TR';
let mapAt = fs.existsSync(MAP_FILE) ? fs.statSync(MAP_FILE).mtimeMs : null;
let mapErr = '', mapBusy = false;
async function renderMap() {
  if (mapBusy) return { ok: false, error: 'zaten çalışıyor' };
  mapBusy = true;
  const raw = path.join(MAP_DIR, 'raw.png'), tmp = path.join(MAP_DIR, 'next.jpg');
  const ud = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chr-'));
  try {
    fs.rmSync(raw, { force: true });
    await runCmd(CHROMIUM, ['--headless', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--hide-scrollbars',
      '--window-size=1000,1300', '--virtual-time-budget=60000', '--user-data-dir=' + ud, '--screenshot=' + raw, MAP_URL], 150000);
    if (!fs.existsSync(raw) || fs.statSync(raw).size < 300000) throw new Error('harita çizilemedi (görüntü boş)');
    // ortadan kırp (Yandex düğmeleri ve çerez kutusu dışarıda kalır), koyu temaya çevir, JPEG'e sıkıştır
    await runFfmpeg(['-y', '-i', raw, '-vf', 'crop=900:1030:30:55,negate,hue=h=180:s=1.15,eq=contrast=1.05:brightness=-0.03:saturation=1.1', '-frames:v', '1', '-q:v', '4', tmp], 60000);
    fs.renameSync(tmp, MAP_FILE);
    mapAt = Date.now(); mapErr = '';
    broadcast({ type: 'state', state: publicState() });
    return { ok: true };
  } catch (e) {
    mapErr = String(e.message).slice(0, 200); console.error('Harita çizilemedi:', mapErr);
    return { ok: false, error: mapErr };
  } finally {
    fs.rmSync(ud, { recursive: true, force: true }); fs.rmSync(raw, { force: true }); fs.rmSync(tmp, { force: true });
    mapBusy = false;
  }
}
function maybeRenderMap() { // ekran bağlı değilse boşuna çizme
  const stale = !mapAt || Date.now() - mapAt > 9.5 * 60 * 1000;
  if (stale && (wss.clients.size > 0 || !mapAt)) renderMap();
}

// ---- Takım logoları: 500 px yerine 128 px'lik küçük sürüm, diskte önbellekli, uzun süreli tarayıcı önbelleği ----
const LOGO_DIR = path.join(DATA_DIR, 'logos');
fs.mkdirSync(LOGO_DIR, { recursive: true });
const logoJobs = new Map();
const localLogo = u => { const m = typeof u === 'string' && u.match(/teamlogos\/soccer\/500\/(\d+)\.png/); return m ? `/logo/${m[1]}.png` : u; };
async function makeLogo(id) {
  const out = path.join(LOGO_DIR, id + '.png');
  if (fs.existsSync(out)) return out;
  const r = await fetch(`https://a.espncdn.com/i/teamlogos/soccer/500/${id}.png`);
  if (!r.ok) throw new Error('logo yok ' + r.status);
  const raw = path.join(LOGO_DIR, id + '.raw.png');
  fs.writeFileSync(raw, Buffer.from(await r.arrayBuffer()));
  try {
    await runFfmpeg(['-y', '-i', raw, '-vf', 'scale=128:128:force_original_aspect_ratio=decrease', '-frames:v', '1', out], 60000);
    fs.rmSync(raw, { force: true });
  } catch (e) { fs.renameSync(raw, out); } // küçültülemezse orijinal kullanılır
  return out;
}
app.get('/traffic-map.jpg', (req, res) => {
  if (!mapAt) return res.status(404).end();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(MAP_FILE);
});
app.get('/logo/:id.png', async (req, res) => {
  if (!/^\d{1,8}$/.test(req.params.id)) return res.status(400).end();
  try {
    if (!logoJobs.has(req.params.id)) logoJobs.set(req.params.id, makeLogo(req.params.id).finally(() => setTimeout(() => logoJobs.delete(req.params.id), 1000)));
    const file = await logoJobs.get(req.params.id);
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.sendFile(file);
  } catch (e) { res.status(404).end(); }
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
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => {
    if (/\.(woff2|png|apk)$/.test(file)) res.setHeader('Cache-Control', /\.apk$/.test(file) ? 'public, max-age=300' : 'public, max-age=2592000, immutable');
  },
}));

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
  tables: CATALOG.filter(([code, , group]) => group !== 'Avrupa Kupaları' && !NO_TABLE.has(code)).map(([code]) => code),
  hideTables: db.hideTables || [],
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
  const districts = Array.isArray(b.districts) ? b.districts.map(x => String(x).trim()).filter(Boolean).slice(0, 2) : cur.districts;
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
  const cfg = { key: (b.key || cur.key || '').trim(), il: (b.il || cur.il || 'İstanbul').trim(), districts: (Array.isArray(b.districts) && b.districts.length ? b.districts : cur.districts || []).map(x => String(x).trim()).filter(Boolean).slice(0, 2) };
  if (!cfg.key) return res.status(400).json({ error: 'Önce API anahtarını girin' });
  if (!cfg.districts.length) return res.status(400).json({ error: 'En az bir ilçe girin' });
  try { const items = await fetchPharmacies(cfg); res.json({ ok: true, count: items.length, sample: items.slice(0, 3) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/admin/bigmatch', (_, res) => res.json({ items: activeBig(), all: bigMatches.length, error: bigError }));
app.put('/api/admin/bigmatch', (req, res) => {
  const b = req.body || {}, cur = bigCfg();
  const num = (v, lo, hi, d) => isFinite(Number(v)) && v !== '' ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : d;
  db.bigMatch = {
    enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled,
    note: typeof b.note === 'string' ? b.note.trim().slice(0, 140) : cur.note,
    days: num(b.days, 1, 7, cur.days), everyMin: num(b.everyMin, 2, 60, cur.everyMin), durSec: num(b.durSec, 5, 60, cur.durSec),
  };
  changed(); res.json({ ok: true });
  refreshBigMatches();
});
app.post('/api/admin/bigmatch/test', (_, res) => {
  const items = activeBig();
  const m = items[0] || { id: 'ornek', league: 'Süper Lig', home: 'Galatasaray', away: 'Fenerbahçe', ts: Date.now() + 3 * 24 * HOUR, hl: null, al: null, derby: true };
  broadcast({ type: 'bigmatch', match: m, cfg: { note: bigCfg().note, durSec: bigCfg().durSec } });
  res.json({ ok: true, sample: !items.length });
});
app.put('/api/admin/movies', (req, res) => {
  const b = req.body || {}, cur = movieCfg();
  db.movies = {
    enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled !== false,
    trailers: typeof b.trailers === 'boolean' ? b.trailers : cur.trailers !== false,
    key: typeof b.key === 'string' ? b.key.trim().slice(0, 120) : cur.key || '',
  };
  moviesFailAt = 0;
  changed(); res.json({ ok: true });
  refreshMovies(true);
});
app.post('/api/admin/movies/test', async (req, res) => {
  try {
    const key = String((req.body || {}).key || movieCfg().key || '').trim();
    if (!key) return res.status(400).json({ error: 'API anahtarı girilmedi' });
    const r = await fetchMovies(key);
    res.json({ count: r.items.length, trailers: r.items.filter(i => i.trailer).length, sample: r.items.slice(0, 3).map(i => i.title) });
  } catch (e) { res.status(502).json({ error: e.message }); }
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
app.post('/api/admin/map/refresh', async (_, res) => { const r = await renderMap(); res.status(r.ok ? 200 : 502).json(r); });
// ---- Depolama: sunucuda ne kadar yer kullanıldığı ----
function dirStat(dir) {
  let bytes = 0, count = 0;
  const walk = d => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { try { bytes += fs.statSync(f).size; count++; } catch {} } } };
  walk(dir);
  return { bytes, count };
}
app.get('/api/admin/storage', (_, res) => {
  const files = {}; let media = 0;
  for (const v of db.videos) { try { files[v.file] = fs.statSync(path.join(UPLOAD_DIR, v.file)).size; media += files[v.file]; } catch {} }
  const known = new Set([...db.videos.map(v => v.file), ...(db.celebPhotos || []).map(p => p.file)]);
  let other = 0, otherN = 0, celeb = 0;
  for (const n of fs.readdirSync(UPLOAD_DIR)) {
    let sz = 0; try { sz = fs.statSync(path.join(UPLOAD_DIR, n)).size; } catch { continue; }
    if ((db.celebPhotos || []).some(p => p.file === n)) celeb += sz;
    else if (!known.has(n)) { other += sz; otherN++; } // listede olmayan (yarım kalmış yükleme vb.)
  }
  const part = d => dirStat(path.join(DATA_DIR, d));
  const uploadsAll = dirStat(UPLOAD_DIR), total = dirStat(DATA_DIR);
  const small = ['db.json', 'cache.json'].reduce((a, f) => a + (fs.existsSync(path.join(DATA_DIR, f)) ? fs.statSync(path.join(DATA_DIR, f)).size : 0), 0);
  let disk = null;
  try { const st = fs.statfsSync(DATA_DIR); disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize }; } catch {}
  res.json({
    files, mediaBytes: media, mediaCount: db.videos.length, celebBytes: celeb, otherBytes: other, otherCount: otherN,
    logosBytes: part('logos').bytes, mapBytes: part('map').bytes, backupsBytes: part('backups').bytes, dbBytes: small,
    uploadsBytes: uploadsAll.bytes, totalBytes: total.bytes, disk,
  });
});
app.get('/api/admin/cache', (_, res) => {
  const age = k => (cache[k] ? Math.round((Date.now() - cache[k].at) / 60000) : null);
  res.json({
    hava: age('weather'), doviz: age('rates:fx'), altin: age('rates:gold'), maclar: age('matches'),
    tarihteBugun: onThisDay ? onThisDay.date : null,
    harita: { dk: mapAt ? Math.round((Date.now() - mapAt) / 60000) : null, hata: mapErr },
    haber: news ? { adet: news.items.length, dk: age('news'), hata: newsError } : (newsError ? { hata: newsError } : null),
    kitap: books ? { adet: books.items.length, dk: age('books'), hata: booksError } : (booksError ? { hata: booksError } : null),
    kota: { eczane: `${quota.month === monthKey() ? quota.pharm : 0}/${QUOTA.pharm.limit}`, haber: `${quota.month === monthKey() ? quota.news : 0}/${QUOTA.news.limit}`, kitap: `${quota.month === monthKey() ? quota.books || 0 : 0}` },
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
app.get('/api/admin/celebrate', (_, res) => res.json({
  enabled: db.showCelebrations !== false,
  holidays: HOLIDAYS.map(h => ({ id: h.id, md: h.md, title: h.title, mourn: !!h.mourn, mode: celebMode(h.id), photos: celebPhotos(h) })),
  active: (activeCelebration() || {}).id || null,
}));
app.put('/api/admin/celebrate/mode', (req, res) => {
  const { id, mode } = req.body || {};
  if (!HOLIDAYS.some(h => h.id === id) || !['auto', 'on', 'off'].includes(mode)) return res.status(400).json({ error: 'geçersiz istek' });
  db.celebMode = { ...(db.celebMode || {}), [id]: mode };
  if (mode === 'on') db.celebPreview = null;
  changed(); res.json({ ok: true });
});
app.post('/api/admin/celebrate/preview', (req, res) => {
  const id = req.body && req.body.id;
  if (!id) { db.celebPreview = null; db.celebPreviewUntil = 0; }
  else if (HOLIDAYS.some(h => h.id === id)) { db.celebPreview = id; db.celebPreviewUntil = Date.now() + 3 * 60 * 1000; }
  else return res.status(400).json({ error: 'bilinmeyen gün' });
  changed(); res.json({ ok: true });
  setTimeout(() => broadcast({ type: 'state', state: publicState() }), 3 * 60 * 1000 + 500);
});
app.post('/api/admin/celebrate/photos', upload.single('file'), (req, res) => {
  const f = req.file, day = req.body && req.body.day;
  if (!f) return res.status(400).json({ error: 'dosya yok' });
  if (!HOLIDAYS.some(h => h.id === day)) { fs.rmSync(f.path, { force: true }); return res.status(400).json({ error: 'geçersiz gün' }); }
  if (!/\.(jpe?g|png|webp)$/i.test(f.originalname) || f.size > 8 * 1024 * 1024) { fs.rmSync(f.path, { force: true }); return res.status(400).json({ error: 'JPG/PNG/WEBP ve en çok 8 MB olmalı' }); }
  db.celebPhotos = db.celebPhotos || [];
  if (db.celebPhotos.filter(x => x.day === day).length >= 12) { fs.rmSync(f.path, { force: true }); return res.status(400).json({ error: 'Bir güne en fazla 12 fotoğraf eklenebilir' }); }
  db.celebPhotos.push({ id: uid(), file: f.filename, day });
  changed(); res.json({ ok: true });
});
app.delete('/api/admin/celebrate/photos/:id', (req, res) => {
  const p = (db.celebPhotos || []).find(x => x.id === req.params.id);
  if (p) { fs.rmSync(path.join(UPLOAD_DIR, p.file), { force: true }); db.celebPhotos = db.celebPhotos.filter(x => x !== p); }
  changed(); res.json({ ok: true });
});
app.put('/api/admin/campaigns/:id', async (req, res) => {
  try {
    const c = db.campaigns.find(x => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'bulunamadı' });
    const b = req.body || {}, str = (v, n) => String(v).trim().slice(0, n);
    if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
    for (const [k, n] of [['headline', 90], ['sub', 140], ['note', 160], ['qrLabel', 60]]) if (typeof b[k] === 'string') c[k] = str(b[k], n);
    if (b.everyMin !== undefined) c.everyMin = Math.max(1, Math.min(60, Math.round(Number(b.everyMin)) || 3));
    if (b.durSec !== undefined) c.durSec = Math.max(8, Math.min(60, Math.round(Number(b.durSec)) || 15));
    if (typeof b.url === 'string' && b.url.trim() !== c.url) {
      const u = b.url.trim();
      if (!/^https?:\/\/\S+$/i.test(u) || u.length > 300) throw new Error('Geçerli bir web adresi (https://...) girin');
      c.url = u; c.svg = await CAMP_QR(u);
    }
    if (c.enabled && !c.svg) c.svg = await CAMP_QR(c.url);
    changed(); res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/campaigns/:id/test', (req, res) => {
  const c = db.campaigns.find(x => x.id === req.params.id && x.svg);
  if (!c) return res.status(404).json({ error: 'bulunamadı' });
  broadcast({ type: 'campaign', camp: pubCamp(c) }); res.json({ ok: true });
});
app.put('/api/admin/options', (req, res) => {
  if (typeof req.body.showStandings === 'boolean') db.showStandings = req.body.showStandings;
  if (Array.isArray(req.body.hideTables)) db.hideTables = req.body.hideTables.filter(c => CATALOG.some(([k]) => k === c));
  if (typeof req.body.showQr === 'boolean') db.showQr = req.body.showQr;
  if (typeof req.body.showOnThisDay === 'boolean') db.showOnThisDay = req.body.showOnThisDay;
  if (typeof req.body.showCelebrations === 'boolean') db.showCelebrations = req.body.showCelebrations;
  if (typeof req.body.showBooks === 'boolean') { db.showBooks = req.body.showBooks; if (db.showBooks) refreshBooks(); }
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
app.post('/api/admin/videos/reorder', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
  const byId = new Map(db.videos.map(v => [v.id, v]));
  const ordered = ids.map(id => byId.get(id)).filter(Boolean);
  const rest = db.videos.filter(v => !ids.includes(v.id)); // listede olmayanlar (yeni yüklenenler) sona
  db.videos = [...new Set([...ordered, ...rest])];
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
  const text = String(req.body.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'kutlama yazısı gerekli' });
  db.birthdays.push({ id: uid(), name: String(req.body.name).slice(0, 60), text, selected: true });
  save(); res.json({ ok: true });
});
app.patch('/api/admin/birthdays/:id', (req, res) => {
  const b = db.birthdays.find(x => x.id === req.params.id);
  if (b && typeof req.body.selected === 'boolean') b.selected = req.body.selected;
  if (b && typeof req.body.text === 'string' && req.body.text.trim()) b.text = req.body.text.trim().slice(0, 200);
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
setTimeout(maybeRenderMap, 20000);
setInterval(maybeRenderMap, 3 * 60 * 1000); // kontrol sıklığı; çizim en çok 10 dakikada bir
const BUILD = require('crypto').createHash('md5').update(fs.readFileSync(path.join(__dirname, 'public/index.html'))).digest('hex');
wss.on('connection', ws => {
  setTimeout(maybeRenderMap, 1500);
  ws.send(JSON.stringify({ type: 'version', build: BUILD, now: Date.now() }));
  ws.send(JSON.stringify({ type: 'state', state: publicState() }));
});

function fireBirthday() {
  const texts = db.birthdays.filter(b => b.selected && b.text).map(b => b.text);
  if (texts.length) broadcast({ type: 'birthday', texts, duration: db.duration });
}
let lastFired = '';
setInterval(() => {
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  if (db.times.includes(now) && lastFired !== now) { lastFired = now; fireBirthday(); }
}, 15000);

server.listen(PORT, () => console.log('Port', PORT));
