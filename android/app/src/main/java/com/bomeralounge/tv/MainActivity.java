package com.bomeralounge.tv;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Bomera TV: ekranı tam ekran web görünümünde açar.
 * İBB trafik endeksini cihazın kendisi çeker (tarayıcı/CORS engeli yok, cihaz Türkiye'de)
 * ve sayfaya window.__nativeTraffic(...) ile verir.
 */
public class MainActivity extends Activity {

    private static final String TV_URL = "https://tv.bomeralounge.com/";
    private static final String IBB_URL = "https://api.ibb.gov.tr/tkmservices/api/TrafficData/v1/TrafficIndex_Sc1_Cont";
    private static final long TRAFFIC_OK_MS = 2 * 60 * 1000;     // başarılıysa 2 dk'da bir
    private static final long TRAFFIC_RETRY_MS = 30 * 1000;      // başarısızsa 30 sn sonra
    private static final long RELOAD_ON_ERROR_MS = 15 * 1000;    // bağlantı hatasında sayfayı yeniden dene

    private WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private volatile String lastTrafficJson = null;
    private boolean stopped = false;

    private final Runnable trafficTask = new Runnable() {
        @Override public void run() {
            new Thread(new Runnable() {
                @Override public void run() {
                    String json = fetchIbb();
                    if (json != null) lastTrafficJson = json;
                    final boolean ok = json != null;
                    handler.post(new Runnable() {
                        @Override public void run() {
                            pushTraffic();
                            if (!stopped) handler.postDelayed(trafficTask, ok ? TRAFFIC_OK_MS : TRAFFIC_RETRY_MS);
                        }
                    });
                }
            }).start();
        }
    };

    private final Runnable reloadTask = new Runnable() {
        @Override public void run() { if (web != null) web.loadUrl(TV_URL); }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.addJavascriptInterface(new Bridge(), "BomeraNative");
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        web.setWebChromeClient(new WebChromeClient() {
            // Android'in video yüklenirken gösterdiği varsayılan "play" simgesini kaldırır
            @Override public Bitmap getDefaultVideoPoster() {
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }
            @Override public View getVideoLoadingProgressView() {
                return new View(MainActivity.this);
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                handler.removeCallbacks(reloadTask);
                pushTraffic(); // sayfa yüklenince son İBB değerini hemen ver
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= 21 && request.isForMainFrame()) {
                    handler.removeCallbacks(reloadTask);
                    handler.postDelayed(reloadTask, RELOAD_ON_ERROR_MS);
                }
            }
            @SuppressWarnings("deprecation")
            @Override public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                handler.removeCallbacks(reloadTask);
                handler.postDelayed(reloadTask, RELOAD_ON_ERROR_MS);
            }
        });
        setContentView(web);
        hideSystemUi();
        web.loadUrl(TV_URL);
        handler.post(trafficTask);
    }

    /** İBB endeksini çeker; {"all":..,"asia":..,"europe":..,"ts":..} döner, olmazsa null. */
    private String fetchIbb() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(IBB_URL).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "BomeraTV/1.0 (Android)");
            if (c.getResponseCode() != 200) return null;
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            String body = sb.toString().trim();
            double all, asia, europe;
            if (body.startsWith("{")) { // JSON: {"TI":9,"TI_An":4,"TI_Av":13}
                JSONObject j = new JSONObject(body);
                all = j.getDouble("TI"); asia = j.getDouble("TI_An"); europe = j.getDouble("TI_Av");
            } else {                    // XML: <TI>9</TI><TI_An>4</TI_An><TI_Av>13</TI_Av>
                Double a = tag(body, "TI"), b = tag(body, "TI_An"), e = tag(body, "TI_Av");
                if (a == null || b == null || e == null) return null;
                all = a; asia = b; europe = e;
            }
            JSONObject out = new JSONObject();
            out.put("all", Math.round(all));
            out.put("asia", Math.round(asia));
            out.put("europe", Math.round(europe));
            out.put("ts", System.currentTimeMillis());
            return out.toString();
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static Double tag(String s, String name) {
        Matcher m = Pattern.compile("<" + name + "[^>]*>\\s*([0-9.,]+)\\s*</" + name + ">", Pattern.CASE_INSENSITIVE).matcher(s);
        return m.find() ? Double.valueOf(m.group(1).replace(',', '.')) : null;
    }

    private void pushTraffic() {
        String j = lastTrafficJson;
        if (web == null || j == null) return;
        web.evaluateJavascript("window.__nativeTraffic && window.__nativeTraffic(" + j + ");", null);
    }

    private void hideSystemUi() {
        View d = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= 19) {
            d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @Override protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (stopped) { stopped = false; handler.removeCallbacks(trafficTask); handler.post(trafficTask); }
    }

    @Override protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override protected void onDestroy() {
        stopped = true;
        handler.removeCallbacksAndMessages(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** Kumandadaki yenile/menü tuşu sayfayı yeniler; geri tuşu uygulamadan çıkmaz (TV ekranı kapanmasın). */
    @Override public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_F5) { web.reload(); return true; }
        if (keyCode == KeyEvent.KEYCODE_BACK) return true;
        return super.onKeyDown(keyCode, event);
    }

    /** Sayfanın APK içinde çalıştığını anlaması için (window.BomeraNative). */
    private class Bridge {
        @JavascriptInterface public boolean isNative() { return true; }
    }
}
