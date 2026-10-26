// İBB trafik yoğunluğu endeksini (%) tarayıcıların okuyabileceği hâle getirir (CORS).
// Cloudflare > Workers & Pages > Create > "Hello World" şablonu > Deploy > Edit code ile bu dosyanın içeriğini yapıştırın.
const SOURCE = 'https://api.ibb.gov.tr/tkmservices/api/TrafficData/v1/TrafficIndex_Sc1_Cont';

// İBB bazen JSON, bazen XML döndürüyor; ikisini de okur.
function parse(text) {
  const t = text.trim();
  if (t.startsWith('{')) {
    const j = JSON.parse(t);
    if (typeof j.TI === 'number') return { all: j.TI, asia: j.TI_An, europe: j.TI_Av };
  }
  const num = tag => { const m = t.match(new RegExp('<' + tag + '[^>]*>\\s*([0-9.,]+)\\s*</' + tag + '>', 'i')); return m ? Number(m[1].replace(',', '.')) : null; };
  const all = num('TI'), asia = num('TI_An'), europe = num('TI_Av');
  if (all !== null) return { all, asia, europe };
  return null;
}

// Başarılı değeri REPORT_SECRET ile imzalar; TV'ler bunu sunucuya bildirir, sunucu imzayı doğrulayıp tüm TV'lere dağıtır.
async function sign(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=60',
    };
    const colo = (request.cf && request.cf.colo) || '?'; // hangi Cloudflare şehrinden çalıştı (IST = İstanbul)
    let snippet = '';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(SOURCE, {
        signal: ctrl.signal,
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; BomeraTV/1.0)' },
        cf: { cacheTtl: 60, cacheEverything: true },
      });
      const text = await r.text();
      clearTimeout(timer);
      snippet = text.slice(0, 200);
      const data = parse(text);
      if (!data) throw new Error('veri okunamadı (HTTP ' + r.status + ')');
      const ts = Date.now();
      const sig = env && env.REPORT_SECRET ? await sign(env.REPORT_SECRET, `${data.all}|${data.asia}|${data.europe}|${ts}`) : undefined;
      return new Response(JSON.stringify({ ...data, ts, sig, colo }), { headers: { ...headers, 'cache-control': 'no-store' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e), colo, snippet }), { status: 502, headers: { ...headers, 'cache-control': 'no-store' } });
    }
  },
};
