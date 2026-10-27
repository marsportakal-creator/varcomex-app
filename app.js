/*
 * Varcomex İklim - telefon uygulaması (PWA)
 * Beyin <-> EMQX Serverless (MQTT over WebSocket TLS). Konular IklimKontrol_C3/UZAK_KONTROL.md'deki gibi:
 *   varcomex/<id>/durum  (JSON, retained)        varcomex/<id>/online (LWT "1"/"0", retained)
 *   varcomex/<id>/kombi/set  true/false          varcomex/<id>/kombi/hedef 15..28
 *   varcomex/<id>/klima/set  true/false          varcomex/<id>/klima/hedef 16..30
 * Arayüzdeki değerler YALNIZCA beyinden gelen durum JSON'uyla değişir (iyimser güncelleme yok).
 */
'use strict';

const VARSAYILAN_SUNUCU = 'wss://v01e1d5b.ala.eu-central-1.emqxsl.com:8084/mqtt';
const DEPO_ANAHTAR = 'varcomex.ayarlar.v1';
const YANIT_SURESI_MS = 5000;
const SINIR = { kombi: [15, 28], klima: [16, 30] };

// ---------- ayarlar (localStorage, try/catch) ----------
let ayarlar = { sunucu: VARSAYILAN_SUNUCU, kullanici: '', sifre: '', cihaz: '', tema: 'sistem' };
let depoCalisiyor = true;

function ayarlariOku() {
  try {
    const ham = localStorage.getItem(DEPO_ANAHTAR);
    if (ham) Object.assign(ayarlar, JSON.parse(ham));
  } catch (e) {
    depoCalisiyor = false;
  }
}

function ayarlariYaz() {
  try {
    localStorage.setItem(DEPO_ANAHTAR, JSON.stringify(ayarlar));
    depoCalisiyor = true;
  } catch (e) {
    depoCalisiyor = false;
  }
}

function ayarTamam() {
  return ayarlar.sunucu && ayarlar.kullanici && ayarlar.sifre && /^[0-9a-f]{12}$/.test(ayarlar.cihaz);
}

function temaUygula() {
  const kok = document.documentElement;
  if (ayarlar.tema === 'acik' || ayarlar.tema === 'koyu') kok.dataset.tema = ayarlar.tema;
  else delete kok.dataset.tema;
}

// ---------- kısa yardımcılar ----------
const $ = (id) => document.getElementById(id);
const sayiMi = (v) => typeof v === 'number' && isFinite(v);
const bicim = (v, ondalik) => (sayiMi(v) ? v.toFixed(ondalik).replace('.', ',') : '--');
const hedefBicim = (v) => (sayiMi(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ',')) : '--');

let uyariZamanlayici = null;
function uyariGoster(metin, sure = 6000) {
  const u = $('uyari');
  u.textContent = metin;
  u.hidden = false;
  clearTimeout(uyariZamanlayici);
  if (sure) uyariZamanlayici = setTimeout(() => { u.hidden = true; }, sure);
}

// ---------- durum ----------
let istemci = null;
let brokerBagli = false;
let beyinOnline = null;          // null = bilinmiyor, true / false
let durum = null;                // son durum JSON'u
let sonDurumZamani = 0;          // son durum mesajının geldiği an (ms)
let durumSayaci = 0;             // her durum mesajında artar

const kok = () => `varcomex/${ayarlar.cihaz}/`;

// ---------- bağlantı ----------
function baglan() {
  if (istemci) { try { istemci.end(true); } catch (e) { /* yok say */ } istemci = null; }
  brokerBagli = false;
  beyinOnline = null;
  durum = null;
  sonDurumZamani = 0;
  ciz();
  if (!ayarTamam()) { ayarlariAc(true); return; }
  if (typeof mqtt === 'undefined') {
    uyariGoster('MQTT kütüphanesi yüklenemedi (internet bağlantısını kontrol et).', 0);
    return;
  }
  const rastgele = Math.random().toString(16).slice(2, 8);
  istemci = mqtt.connect(ayarlar.sunucu, {
    username: ayarlar.kullanici,
    password: ayarlar.sifre,
    clientId: `vcx-app-${rastgele}`,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 4000,
    connectTimeout: 10000,
  });
  istemci.on('connect', () => {
    brokerBagli = true;
    $('uyari').hidden = true;
    istemci.subscribe([kok() + 'durum', kok() + 'online'], { qos: 1 }, (hata) => {
      if (hata) uyariGoster('Konulara abone olunamadı: ' + hata.message, 0);
    });
    ciz();
  });
  istemci.on('reconnect', () => { brokerBagli = false; ciz(); });
  istemci.on('close', () => { brokerBagli = false; ciz(); });
  istemci.on('offline', () => { brokerBagli = false; ciz(); });
  istemci.on('error', (hata) => {
    const m = String(hata && hata.message || hata);
    if (/not authorized|bad user|auth/i.test(m)) {
      uyariGoster('Kullanıcı adı ya da şifre kabul edilmedi. Ayarları kontrol et.', 0);
      istemci.end(true);
    } else {
      uyariGoster('Bağlantı hatası: ' + m);
    }
  });
  istemci.on('message', mesajGeldi);
}

function mesajGeldi(konu, veri) {
  const metin = veri.toString();
  if (konu === kok() + 'online') {
    beyinOnline = metin.trim() === '1';
  } else if (konu === kok() + 'durum') {
    try {
      durum = JSON.parse(metin);
      sonDurumZamani = Date.now();
      durumSayaci++;
      bekleyenleriKontrolEt();
    } catch (e) {
      uyariGoster('Beyinden okunamayan durum mesajı geldi.');
    }
  }
  ciz();
}

// ---------- komutlar (gönder -> "gönderiliyor" -> beyinden durum ya da 5 sn uyarı) ----------
// bekleyen: { anahtar, dugme, eskiMetin, beklenen(durum) -> bool, sayac, zamanlayici }
const bekleyenler = new Map();

function gonder(anahtar, dugme, altKonu, deger, beklenen, aciklama) {
  if (!istemci || !brokerBagli) { uyariGoster('Sunucuya bağlı değil, komut gönderilmedi.'); return; }
  if (beyinOnline === false) { uyariGoster('Beyin çevrimdışı, komut gönderilmedi.'); return; }
  if (bekleyenler.has(anahtar)) return;
  const kayit = {
    dugme, eskiMetin: dugme.textContent, beklenen, aciklama,
    sayac: durumSayaci,
    zamanlayici: setTimeout(() => zamanAsimi(anahtar), YANIT_SURESI_MS),
  };
  bekleyenler.set(anahtar, kayit);
  dugme.classList.add('gonderiliyor');
  dugme.setAttribute('aria-busy', 'true');
  if (dugme.classList.contains('ana-dugme')) dugme.textContent = 'Gönderiliyor…';
  ciz();
  istemci.publish(kok() + altKonu, String(deger), { qos: 1, retain: false }, (hata) => {
    if (hata) { bitir(anahtar); uyariGoster('Komut gönderilemedi: ' + hata.message); }
  });
}

function bitir(anahtar) {
  const k = bekleyenler.get(anahtar);
  if (!k) return;
  clearTimeout(k.zamanlayici);
  k.dugme.classList.remove('gonderiliyor');
  k.dugme.removeAttribute('aria-busy');
  k.dugme.textContent = k.eskiMetin;
  bekleyenler.delete(anahtar);
}

function bekleyenleriKontrolEt() {
  for (const [anahtar, k] of bekleyenler) {
    if (durumSayaci > k.sayac && k.beklenen(durum)) bitir(anahtar);
  }
}

function zamanAsimi(anahtar) {
  const k = bekleyenler.get(anahtar);
  if (!k) return;
  const yanitVar = durumSayaci > k.sayac;
  bitir(anahtar);
  ciz();
  uyariGoster(yanitVar
    ? `${k.aciklama}: beyin yanıt verdi ama değer değişmedi (komut uygulanmamış olabilir).`
    : `${k.aciklama}: beyinden 5 sn içinde yanıt gelmedi.`, 8000);
}

function hedefDegistir(cihaz, fark, dugme) {
  const c = durum && durum[cihaz];
  if (!c || !sayiMi(c.hedef)) return;
  const [mn, mx] = SINIR[cihaz];
  const yeni = Math.min(mx, Math.max(mn, Math.round((c.hedef + fark) * 10) / 10));
  if (yeni === c.hedef) return;
  gonder(`${cihaz}-hedef`, dugme, `${cihaz}/hedef`, yeni,
    (d) => d && d[cihaz] && sayiMi(d[cihaz].hedef) && Math.abs(d[cihaz].hedef - yeni) < 0.01,
    `${cihaz === 'kombi' ? 'Kombi' : 'Klima'} hedefi ${hedefBicim(yeni)}°`);
}

function acKapat(cihaz, dugme) {
  const c = durum && durum[cihaz];
  const ac = !(c && c.acik === true);
  gonder(`${cihaz}-set`, dugme, `${cihaz}/set`, ac ? 'true' : 'false',
    (d) => d && d[cihaz] && d[cihaz].acik === ac,
    `${cihaz === 'kombi' ? 'Kombi' : 'Klima'} ${ac ? 'aç' : 'kapat'}`);
}

// ---------- çizim ----------
const KOMBI_DURUM = { isitiyor: 'Isıtıyor', beklemede: 'Beklemede', kapali: 'Kapalı', acik: 'Açık' };
const KLIMA_DURUM = { sogutuyor: 'Soğutuyor', bekliyor: 'Beklemede', kapali: 'Kapalı' };

function gecenSure(ms) {
  const sn = Math.round((Date.now() - ms) / 1000);
  if (sn < 5) return 'az önce';
  if (sn < 60) return `${sn} sn önce`;
  const dk = Math.floor(sn / 60);
  if (dk < 60) return `${dk} dk önce`;
  return new Date(ms).toLocaleString('tr-TR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

function ustCiz() {
  const nokta = $('beyinNokta');
  nokta.classList.remove('cevrimici', 'cevrimdisi');
  let yazi;
  if (!ayarTamam()) yazi = 'Ayar gerekli';
  else if (!brokerBagli) yazi = 'Sunucuya bağlanıyor…';
  else if (beyinOnline === true) { yazi = 'Beyin çevrimiçi'; nokta.classList.add('cevrimici'); }
  else if (beyinOnline === false) { yazi = 'Beyin çevrimdışı'; nokta.classList.add('cevrimdisi'); }
  else yazi = 'Beyin durumu bekleniyor…';
  $('beyinYazi').textContent = yazi;
  $('sonGuncelleme').textContent = sonDurumZamani ? 'güncelleme ' + gecenSure(sonDurumZamani) : 'henüz veri yok';
}

function kontrolAcik() {
  return brokerBagli && beyinOnline === true && durum !== null;
}

function kombiCiz() {
  const k = (durum && durum.kombi) || {};
  const kart = $('kombiKart');
  kart.classList.toggle('isitiyor', k.durum === 'isitiyor');
  $('kombiDurum').textContent = KOMBI_DURUM[k.durum] || 'Bilinmiyor';
  $('kombiOda').textContent = bicim(durum && durum.oda, 1);
  $('kombiNem').textContent = 'nem ' + (sayiMi(durum && durum.nem) ? '%' + Math.round(durum.nem) : '--');
  $('kombiHedef').textContent = hedefBicim(k.hedef);

  const acik = kontrolAcik();
  const [mn, mx] = SINIR.kombi;
  const hedefVar = sayiMi(k.hedef);
  if (!bekleyenler.has('kombi-hedef')) {
    $('kombiEksi').disabled = !acik || !hedefVar || k.hedef <= mn;
    $('kombiArti').disabled = !acik || !hedefVar || k.hedef >= mx;
  } else {
    $('kombiEksi').disabled = $('kombiArti').disabled = true;
  }
  const d = $('kombiAcKapat');
  if (!bekleyenler.has('kombi-set')) {
    d.textContent = k.acik === true ? 'Kombiyi kapat' : 'Kombiyi aç';
    d.classList.toggle('kapat', k.acik === true);
    d.disabled = !acik;
  }
}

function klimaCiz() {
  const k = durum && durum.klima;
  const kart = $('klimaKart');
  const bagliDegil = !k || k.acik === null || k.acik === undefined || k.ulasilabilir === false;
  $('klimaYok').hidden = !bagliDegil;
  $('klimaIcerik').hidden = bagliDegil;
  if (bagliDegil) {
    kart.classList.remove('sogutuyor');
    $('klimaYok').textContent = 'Klima kiti bağlı değil';
    $('klimaDurum').textContent = '—';
    return;
  }
  if (k.eslesmis === false) {
    kart.classList.remove('sogutuyor');
    $('klimaYok').hidden = false;
    $('klimaIcerik').hidden = true;
    $('klimaYok').textContent = 'Klima eşleşmemiş (kitte iki butona 3 sn basın)';
    $('klimaDurum').textContent = '—';
    return;
  }
  kart.classList.toggle('sogutuyor', k.durum === 'sogutuyor');
  $('klimaDurum').textContent = KLIMA_DURUM[k.durum] || 'Bilinmiyor';
  $('klimaOda').textContent = bicim(k.oda, 1);
  $('klimaHedef').textContent = hedefBicim(k.hedef);

  const acik = kontrolAcik();
  const [mn, mx] = SINIR.klima;
  const ayarOlur = acik && k.acik === true && sayiMi(k.hedef);
  $('klimaIpucu').hidden = k.acik === true;
  if (!bekleyenler.has('klima-hedef')) {
    $('klimaEksi').disabled = !ayarOlur || k.hedef <= mn;
    $('klimaArti').disabled = !ayarOlur || k.hedef >= mx;
  } else {
    $('klimaEksi').disabled = $('klimaArti').disabled = true;
  }
  const d = $('klimaAcKapat');
  if (!bekleyenler.has('klima-set')) {
    d.textContent = k.acik === true ? 'Klimayı kapat' : 'Klimayı aç';
    d.classList.toggle('kapat', k.acik === true);
    d.disabled = !acik;
  }
}

function pilCiz() {
  const p = (durum && durum.pil) || {};
  const yaz = (id, yuzde, dusuk) => {
    const el = $(id);
    el.textContent = sayiMi(yuzde) ? `%${yuzde}${dusuk ? ' (düşük)' : ''}` : '--';
    el.classList.toggle('dusuk', !!dusuk);
  };
  yaz('pilBeyin', p.beyin, p.beyin_dusuk);
  yaz('pilTermostat', p.termostat, p.termostat_dusuk);
}

function ciz() {
  ustCiz();
  kombiCiz();
  klimaCiz();
  pilCiz();
}

// ---------- ayar ekranı ----------
function ayarlariAc(zorunlu) {
  const dlg = $('ayarlar');
  $('aSunucu').value = ayarlar.sunucu || VARSAYILAN_SUNUCU;
  $('aKullanici').value = ayarlar.kullanici || '';
  $('aSifre').value = ayarlar.sifre || '';
  $('aCihaz').value = ayarlar.cihaz || '';
  $('aTema').value = ayarlar.tema || 'sistem';
  $('ayarIptal').hidden = !!zorunlu;
  $('ayarHata').hidden = true;
  if (!dlg.open) dlg.showModal();
}

function ayarlariKaydet(olay) {
  olay.preventDefault();
  const sunucu = $('aSunucu').value.trim();
  const cihaz = $('aCihaz').value.trim().toLowerCase();
  const hata = $('ayarHata');
  if (!/^wss:\/\//i.test(sunucu)) { hata.textContent = 'Sunucu wss:// ile başlamalı (şifreli WebSocket).'; hata.hidden = false; return; }
  if (!/^[0-9a-f]{12}$/.test(cihaz)) { hata.textContent = 'Cihaz kimliği 12 karakter olmalı (0-9, a-f).'; hata.hidden = false; return; }
  ayarlar = {
    sunucu,
    kullanici: $('aKullanici').value.trim(),
    sifre: $('aSifre').value,
    cihaz,
    tema: $('aTema').value,
  };
  ayarlariYaz();
  temaUygula();
  $('ayarlar').close();
  if (!depoCalisiyor) uyariGoster('Tarayıcı deposu kullanılamıyor: ayarlar yalnızca bu oturumda geçerli.', 8000);
  baglan();
}

// ---------- başlangıç ----------
function basla() {
  ayarlariOku();
  temaUygula();

  $('ayarAc').addEventListener('click', () => ayarlariAc(false));
  $('ayarIptal').addEventListener('click', () => $('ayarlar').close());
  $('ayarForm').addEventListener('submit', ayarlariKaydet);
  $('ayarlar').addEventListener('cancel', (e) => { if (!ayarTamam()) e.preventDefault(); });

  $('kombiEksi').addEventListener('click', (e) => hedefDegistir('kombi', -1, e.currentTarget));
  $('kombiArti').addEventListener('click', (e) => hedefDegistir('kombi', +1, e.currentTarget));
  $('kombiAcKapat').addEventListener('click', (e) => acKapat('kombi', e.currentTarget));
  $('klimaEksi').addEventListener('click', (e) => hedefDegistir('klima', -1, e.currentTarget));
  $('klimaArti').addEventListener('click', (e) => hedefDegistir('klima', +1, e.currentTarget));
  $('klimaAcKapat').addEventListener('click', (e) => acKapat('klima', e.currentTarget));

  setInterval(ustCiz, 1000);              // "x sn önce" yazısı
  ciz();
  baglan();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* yerel dosyadan açılınca olmaz, sorun değil */ });
  }
}

document.addEventListener('DOMContentLoaded', basla);
