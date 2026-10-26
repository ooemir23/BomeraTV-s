// İBB trafik yoğunluğu endeksini (%) tarayıcıların okuyabileceği hâle getirir (CORS).
// Cloudflare > Workers & Pages > Create > "Hello World" şablonu > Deploy > Edit code ile bu dosyanın içeriğini yapıştırın.
const SOURCE = 'https://api.ibb.gov.tr/tkmservices/api/TrafficData/v1/TrafficIndex_Sc1_Cont';

export default {
  async fetch(request) {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=60',
    };
    const colo = (request.cf && request.cf.colo) || '?'; // hangi Cloudflare şehrinden çalıştı (IST = İstanbul)
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(SOURCE, { signal: ctrl.signal, cf: { cacheTtl: 60, cacheEverything: true } });
      clearTimeout(t);
      const j = await r.json();
      if (typeof j.TI !== 'number') throw new Error('beklenmeyen yanıt');
      return new Response(JSON.stringify({ all: j.TI, asia: j.TI_An, europe: j.TI_Av, colo }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e), colo }), { status: 502, headers: { ...headers, 'cache-control': 'no-store' } });
    }
  },
};
