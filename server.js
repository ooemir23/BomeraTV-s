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

let db = { videos: [], matches: [], birthdays: [], times: ['13:00', '19:00'], duration: 40 };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

let rates = { usd: null, eur: null, updated: null };
async function refreshRates() {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    const t = j.rates.TRY;
    rates = { usd: t, eur: t / j.rates.EUR, updated: new Date().toISOString() };
    broadcast({ type: 'rates', rates });
  } catch (e) { console.error('Kur alınamadı:', e.message); }
}
refreshRates();
setInterval(refreshRates, 10 * 60 * 1000);

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
  videos: db.videos.map(v => ({ id: v.id, name: v.name, url: '/uploads/' + v.file })),
  matches: db.matches.slice().sort((a, b) => a.time.localeCompare(b.time)),
  rates,
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
  for (const f of req.files) db.videos.push({ id: uid(), file: f.filename, name: f.originalname });
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
wss.on('connection', ws => ws.send(JSON.stringify({ type: 'state', state: publicState() })));

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
