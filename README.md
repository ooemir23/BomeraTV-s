# BomeraTV

Kafe TV'leri için bulut tabanlı ekran uygulaması: video döngüsü, maç takvimi, USD/EUR kurları ve zamanlanmış doğum günü kayan yazısı.

- TV ekranı: `/` (Android box tarayıcısında tam ekran açın)
- Admin paneli: `/admin` (kullanıcı `ADMIN_USER`, şifre `ADMIN_PASS`)

## Çalıştırma
    npm install
    ADMIN_PASS=guclusifre npm start

Ortam değişkenleri: `PORT`, `ADMIN_USER`, `ADMIN_PASS`, `DATA_DIR`, `TZ_NAME` (varsayılan Europe/Istanbul).
Bulutta kalıcı disk bağlayıp `DATA_DIR` olarak verin (videolar ve veriler orada saklanır). Dockerfile hazırdır.

## Android uygulaması (APK) güncelleme
- Yeni sürüm: `android/app/build.gradle` içinde `versionCode`/`versionName` artırılır, APK derlenip `public/BomeraTV.apk` olarak değiştirilir ve `public/apk-version.json` aynı sürümle güncellenir.
- Deploy sonrası, v1.4 ve sonrasını çalıştıran kutularda kumandadaki Menü tuşu bir panel açar (kurulu sürüm, sunucudaki sürüm, "Güncellemeyi kontrol et"). Yeni sürüm varsa panelde "Yeni sürümü indir ve kur" çıkar; OK APK yı indirip yükleyiciyi açar. Geri tuşu paneli kapatır.
- APK aynı (debug) anahtarla imzalanmalıdır, aksi halde üzerine kurulmaz.
