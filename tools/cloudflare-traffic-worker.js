// İBB trafik yoğunluğu endeksini (%) tarayıcıların okuyabileceği hâle getirir (CORS).
// Cloudflare > Workers & Pages > Create > "Hello World" şablonu > Deploy > Edit code ile bu dosyanın içeriğini yapıştırın.
const SOURCE = 'https://api.ibb.gov.tr/tkmservices/api/TrafficData/v1/TrafficIndex_Sc1_Cont';

export default {
  async fetch() {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=60',
    };
    try {
      const r = await fetch(SOURCE, { cf: { cacheTtl: 60, cacheEverything: true } });
      const j = await r.json();
      if (typeof j.TI !== 'number') throw new Error('beklenmeyen yanıt');
      return new Response(JSON.stringify({ all: j.TI, asia: j.TI_An, europe: j.TI_Av }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers });
    }
  },
};
