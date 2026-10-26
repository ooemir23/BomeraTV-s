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

export default {
  async fetch(request) {
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
      return new Response(JSON.stringify({ ...data, colo }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e), colo, snippet }), { status: 502, headers: { ...headers, 'cache-control': 'no-store' } });
    }
  },
};
