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

let db = { videos: [], matches: [], birthdays: [], times: ['13:00', '19:00'], duration: 40, imageSeconds: 10 };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

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
  } catch (e) { console.error('Altın alınamadı:', e.message); }
}
refreshRates();
setInterval(refreshRates, 10 * 60 * 1000);

const LEAGUES = [
  ['uefa.champions', 'Şampiyonlar Ligi'],
  ['uefa.europa', 'Avrupa Ligi'],
  ['tur.1', 'Süper Lig'],
  ['tur.2', 'TFF 1. Lig'],
  ['esp.1', 'La Liga'],
  ['eng.1', 'Premier Lig'],
  ['ita.1', 'Serie A'],
  ['ger.1', 'Bundesliga'],
  ['fra.1', 'Ligue 1'],
];
const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // YYYY-MM-DD
const hm = d => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
let autoMatches = [];
async function refreshMatches() {
  const out = [];
  const today = ymd(new Date());
  for (let i = 0; i < 2; i++) {
    const day = new Date(Date.now() + i * 86400000);
    const q = ymd(day).replace(/-/g, '');
    for (const [code, label] of LEAGUES) {
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard?dates=${q}`);
        const j = await r.json();
        for (const e of j.events || []) {
          const st = e.status.type.state;
          if (st === 'post' && i > 0) continue;
          const c = e.competitions[0].competitors;
          const home = c.find(x => x.homeAway === 'home'), away = c.find(x => x.homeAway === 'away');
          const when = new Date(e.date);
          out.push({
            id: e.id, league: label, home: home.team.shortDisplayName || home.team.displayName,
            away: away.team.shortDisplayName || away.team.displayName,
            ts: when.getTime(), day: ymd(when) === today ? 'Bugün' : 'Yarın', time: hm(when),
            live: st === 'in', final: st === 'post',
            hs: st === 'pre' ? null : home.score, as: st === 'pre' ? null : away.score,
            clock: st === 'in' ? e.status.displayClock : null,
          });
        }
      } catch (err) { console.error('Maç alınamadı', code, err.message); }
    }
  }
  const seen = new Set();
  const rank = m => (m.live ? 0 : m.final ? 2 : 1);
  autoMatches = out.filter(m => !seen.has(m.id) && seen.add(m.id)).sort((a, b) => rank(a) - rank(b) || a.ts - b.ts);
  broadcast({ type: 'state', state: publicState() });
}
(async function loop() {
  await refreshMatches();
  setTimeout(loop, autoMatches.some(m => m.live) ? 45 * 1000 : 5 * 60 * 1000);
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
  matches: [
    ...db.matches.slice().sort((a, b) => a.time.localeCompare(b.time)).map(m => ({ ...m, day: 'Bugün' })),
    ...autoMatches,
  ].slice(0, 30),
  rates,
  weather,
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
