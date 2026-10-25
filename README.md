# BomeraTV

Kafe TV'leri için bulut tabanlı ekran uygulaması: video döngüsü, maç takvimi, USD/EUR kurları ve zamanlanmış doğum günü kayan yazısı.

- TV ekranı: `/` (Android box tarayıcısında tam ekran açın)
- Admin paneli: `/admin` (kullanıcı `ADMIN_USER`, şifre `ADMIN_PASS`)

## Çalıştırma
    npm install
    ADMIN_PASS=guclusifre npm start

Ortam değişkenleri: `PORT`, `ADMIN_USER`, `ADMIN_PASS`, `DATA_DIR`, `TZ_NAME` (varsayılan Europe/Istanbul).
Bulutta kalıcı disk bağlayıp `DATA_DIR` olarak verin (videolar ve veriler orada saklanır). Dockerfile hazırdır.
