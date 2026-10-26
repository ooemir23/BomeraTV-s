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

let db = { videos: [], matches: [], birthdays: [], times: ['13:00', '19:00'], duration: 40, imageSeconds: 10, reviews: [], leagues: null, channels: {}, leagueChannels: {}, showStandings: true, trafficApi: '' };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

let traffic = null;
async function refreshTraffic() {
  try {
    const r = await fetch('https://api.ibb.gov.tr/tkmservices/api/TrafficData/v1/TrafficIndex_Sc1_Cont');
    const j = await r.json();
    if (typeof j.TI !== 'number') throw new Error('beklenmeyen yanıt');
    traffic = { all: j.TI, asia: j.TI_An, europe: j.TI_Av, updated: new Date().toISOString() };
    broadcast({ type: 'traffic', traffic });
  } catch (e) { console.error('Trafik endeksi alınamadı:', e.message); }
}
refreshTraffic();
setInterval(refreshTraffic, 2 * 60 * 1000);

let weather = null;
async function refreshWeather() {
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=41.01&longitude=28.98&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day&daily=temperature_2m_max,temperature_2m_min&timezone=Europe%2FIstanbul&forecast_days=1');
    const j = await r.json();
    weather = {
      temp: j.current.temperature_2m, feels: j.current.apparent_temperature, code: j.current.weather_code,
      wind: j.current.wind_speed_10m, day: !!j.current.is_day,
      max: j.daily.temperature_2m_max[0], min: j.daily.temperature_2m_min[0],
    };
    broadcast({ type: 'weather', weather });
  } catch (e) { console.error('Hava durumu alınamadı:', e.message); }
}
refreshWeather();
setInterval(refreshWeather, 15 * 60 * 1000);

let rates = { usd: null, eur: null, gold: null, updated: null };
async function refreshRates() {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    const t = j.rates.TRY;
    rates = { ...rates, usd: t, eur: t / j.rates.EUR, updated: new Date().toISOString() };
    broadcast({ type: 'rates', rates });
  } catch (e) { console.error('Kur alınamadı:', e.message); }
  try {
    const g = await (await fetch('https://finans.truncgil.com/v4/today.json')).json();
    rates = { ...rates, gold: Number(g.GRA.Selling) };
    broadcast({ type: 'rates', rates });
  } catch (e) { console.error('Altın alınamadı:', e.message); if (!rates.gold) setTimeout(refreshRates, 30 * 1000); }
}
refreshRates();
setInterval(refreshRates, 10 * 60 * 1000);

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
async function refreshStandings() {
  const targets = CATALOG.filter(([code, , group]) => enabledLeagues().some(([c]) => c === code) && group !== 'Avrupa Kupaları' && !NO_TABLE.has(code));
  await Promise.all(targets.map(async ([code]) => {
    try {
      const r = await fetch(`https://site.api.espn.com/apis/v2/sports/soccer/${code}/standings`);
      const j = await r.json();
      const ch = j.children || [];
      if (ch.length !== 1) { standings.delete(code); return; } // grup/konferans yapılı veya veri yok
      const num = (e, n) => { const x = e.stats.find(s => s.name === n); return x ? (x.displayValue ?? String(x.value)) : ''; };
      standings.set(code, ch[0].standings.entries.map(e => ({
        rank: Number(num(e, 'rank')), name: e.team.shortDisplayName || e.team.displayName,
        logo: (e.team.logos || [])[0] ? e.team.logos[0].href : null,
        gp: num(e, 'gamesPlayed'), w: num(e, 'wins'), d: num(e, 'ties'), l: num(e, 'losses'), gd: num(e, 'pointDifferential'), pts: num(e, 'points'),
      })).sort((a, b) => a.rank - b.rank));
    } catch (err) { console.error('Puan durumu alınamadı', code, err.message); }
  }));
  broadcast({ type: 'state', state: publicState() });
}
const enabledLeagues = () => CATALOG.filter(([code]) => (db.leagues || DEFAULT_LEAGUES).includes(code)).map(([code, label]) => [code, label]);
const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // YYYY-MM-DD
const hm = d => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
let autoMatches = [];
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
setInterval(refreshStandings, 30 * 60 * 1000);
(async function loop() {
  await refreshMatches();
  setTimeout(loop, autoMatches.some(m => m.live) ? 25 * 1000 : 5 * 60 * 1000);
})();

const app = express();
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
  videos: db.videos.map(v => ({ id: v.id, name: v.name, url: '/uploads/' + v.file, type: v.type || 'video' })),
  imageSeconds: db.imageSeconds,
  reviews: (db.reviews || []).filter(r => r.rating >= 4).map(({ id, author, rating, text }) => ({ id, author, rating, text })),
  matches: [
    ...db.matches.slice().sort((a, b) => a.time.localeCompare(b.time)).map(m => ({ ...m, day: 'Bugün' })),
    ...autoMatches.filter(m => enabledLeagues().some(([, label]) => label === m.league)),
  ].slice(0, 30).map(m => ({ ...m, channel: (db.channels || {})[`${m.league}|${m.home}|${m.away}`] || (db.leagueChannels || {})[m.league] || null })),
  showStandings: db.showStandings !== false,
  trafficApi: db.trafficApi || '',
  standings: Object.fromEntries(enabledLeagues().filter(([code]) => standings.has(code)).map(([code, label]) => [label, standings.get(code)])),
  rates,
  weather,
  traffic,
});
app.get('/api/state', (_, res) => res.json(publicState()));
app.use('/uploads', express.static(UPLOAD_DIR));
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
app.put('/api/admin/options', (req, res) => {
  if (typeof req.body.showStandings === 'boolean') db.showStandings = req.body.showStandings;
  if (typeof req.body.trafficApi === 'string') {
    const u = req.body.trafficApi.trim();
    if (u && !/^https:\/\/[^\s]+$/.test(u)) return res.status(400).json({ error: 'Adres https:// ile başlamalı' });
    db.trafficApi = u;
  }
  changed(); res.json({ ok: true });
});
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
  for (const f of req.files) db.videos.push({ id: uid(), file: f.filename, name: f.originalname, type: f.mimetype.startsWith('image/') ? 'image' : 'video' });
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
const wss = new WebSocketServer({ server, path: '/ws' });
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
