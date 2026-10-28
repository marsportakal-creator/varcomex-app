# Varcomex İklim – telefon uygulaması (PWA)

Kombiyi ve klimayı telefondan izleyip yönetir. Beyin ile aynı EMQX Serverless sunucusuna **MQTT over WebSocket TLS** (`wss://…:8084/mqtt`) ile bağlanır. Konular `IklimKontrol_C3/UZAK_KONTROL.md`'dekilerle aynı.

| Dosya | Görev |
|---|---|
| `index.html` | Arayüz (bağlantı durumu, kombi kartı, klima kartı, ayarlar) |
| `style.css` | Mobil öncelikli tasarım, açık/koyu tema |
| `app.js` | MQTT bağlantısı, durum JSON'unu çizme, komutlar |
| `sw.js` | Service worker: yalnızca arayüz dosyalarını önbelleğe alır |
| `manifest.json`, `icons/` | Ana ekrana eklenebilir uygulama |

## Kullanım

- **İlk açılış:** ayar ekranı gelir. EMQX kullanıcı adı, şifre ve cihaz kimliği (`206ef16c8c8c`) girilir.
  - Bunlar koda yazılı değildir; yalnızca o telefondaki tarayıcı deposunda (localStorage) saklanır.
  - Sonradan ⚙ ile değiştirilebilir.
- **Üst satır:** beyin çevrimiçi/çevrimdışı (`online` LWT) ve son durum güncellemesinin ne kadar önce geldiği.
- **Kombi kartı:** oda sıcaklığı, nem, hedef (−/+ ile 15–28), aç/kapat, durum. Kombi ısıtırken kart turuncu-kırmızı olur (termostattaki ekran gibi).
- **Klima kartı:**
  - Yapı kombiyle aynı; hedef 16–30.
  - Mod düğmeleri (Soğutma / Isıtma / Fan; seçili olan vurgulu) ve fan hızı −/+ (Otomatik → Düşük → Orta → Yüksek, uçlarda durur).
  - Hedef yalnızca klima açıkken değişir; fan modunda hedef gizlenir.
  - Klima açıkken kart ısıtma modunda turuncu-kırmızı, soğutma modunda mavi olur.
  - Kit veri vermiyorsa "Klima kiti bağlı değil" yazar.
- **Komutlar:**
  - Düğme kısa süre "gönderiliyor" durumuna geçer.
  - Ekrandaki değer **yalnızca beyinden gelen durum JSON'uyla** değişir.
  - 5 sn içinde beklenen değer gelmezse uyarı çıkar: "yanıt gelmedi" ya da "değer değişmedi".
- **Kontroller kapalıyken:** beyin çevrimdışıyken ya da sunucuya bağlı değilken düğmeler kapalıdır.

## EMQX'te telefon kullanıcısı

EMQX konsolu → **Access Control → Authentication → Add**: telefon için ayrı bir kullanıcı ekle. Beyinle aynı kullanıcı adı kullanılabilir. Ama ayrı kullanıcı, telefon kaybolunca yalnızca onu silmeyi sağlar.

> Şifre telefonda tarayıcı deposunda düz metin olarak durur. Telefon başkasının eline geçerse EMQX'ten bu kullanıcının şifresini değiştir ya da sil.

## GitHub Pages'ta yayınlama (adım adım)

PWA'nın (service worker, ana ekrana ekleme) çalışması için sayfanın **HTTPS** üzerinden açılması gerekir. GitHub Pages bunu ücretsiz sağlar.

1. github.com'da oturum aç → sağ üst **+** → **New repository**.
   - Ad: ör. `varcomex-app`.
   - **Public** seç (ücretsiz hesapta Pages yalnızca açık depolarda çalışır).
   - **Create repository**.
2. Açılan sayfada **uploading an existing file** bağlantısına tıkla.
   - Bu klasörün **içindekileri** sürükle: `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json`, `README.md` ve `icons` klasörü.
   - `icons` klasörünü klasör olarak sürükle; GitHub yolunu korur.
   - **Commit changes**.
3. Deponun **Settings** → sol menü **Pages** →
   **Build and deployment / Source: Deploy from a branch** → Branch: **main**, klasör **/(root)** → **Save**.
4. 1–2 dk bekle. Pages sayfasının üstünde adres çıkar: `https://<kullanıcı-adın>.github.io/varcomex-app/`.
5. Telefonda bu adresi aç, ayarları gir.
   - **Android (Chrome):** menü ⋮ → **Ana ekrana ekle** (ya da **Uygulamayı yükle**).
   - **iPhone (Safari):** Paylaş → **Ana Ekrana Ekle**.

**Güncelleme:** dosyaları depoda yenileriyle değiştir (Add file → Upload files, aynı adlarla). Sonra `sw.js` içindeki `SURUM` değerini artır (ör. `varcomex-ui-v2`); telefonlar yeni sürümü bir sonraki açılışta alır.

**Gizlilik:** depoda kullanıcı adı, şifre ya da cihaz kimliği **yok**; yalnızca sunucu adresi var. Depo açık olduğu için başka hiçbir bilgi ekleme.

## Bilgisayarda deneme

`file://` ile açınca service worker çalışmaz. Klasörde basit bir sunucu başlat:

```bash
python -m http.server 8765
```

Sonra `http://localhost:8765` adresini aç. localhost'ta service worker HTTPS olmadan da çalışır.

## Teknik notlar

- **MQTT.js 5.10.1**, unpkg CDN'den yüklenir; service worker onu önbelleğe almaz. Uygulama çevrimdışı açılır ama bağlanmak için internet gerekir.
- **Bağlantı ayarları:**
  - İstemci kimliği her açılışta rastgele (`vcx-app-xxxxxx`); beyinle ya da başka telefonla çakışmaz.
  - `clean: true`, yeniden bağlanma 4 sn'de bir.
- **Yayın:** komutlar QoS 1 ve **retain kapalı** gönderilir. Açık/kapat için `true`/`false`, hedef için sayı (termostat x.5'teyse x.5 ± 1).
- **Okunan konular:** `durum` (retained JSON) ve `online` ("1"/"0").
