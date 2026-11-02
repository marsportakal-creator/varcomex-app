/*
 * Haftalık program (app.js'ten sonra yüklenir). Program beyinde çalışır ve orada saklanır;
 * burada yalnızca düzenlenir ve tam liste olarak varcomex/<id>/program/set ile gönderilir.
 * "Kaydedildi" yalnızca beyinden aynı id'li program/durum { sonuc: "ok" } gelince gösterilir.
 */
'use strict';

const GUNLER = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const PRG_MAX = 20;

let prgSunucu = null;      // beyinden gelen son program/durum
let prgTaslak = [];        // düzenlenen kurallar
let prgKonfor = 22;
let prgKirli = false;      // kaydedilmemiş değişiklik
let prgBekleyen = null;    // { id, zamanlayici } kaydet bekleniyor
let prgDurBekleyen = null; // { deger, zamanlayici } duraklat/devam bekleniyor
let kuralDuzenlenen = -1;  // -1 = yeni kural

const kopya = (o) => JSON.parse(JSON.stringify(o));
const ikiHane = (n) => String(n).padStart(2, '0');

// ---------- sekmeler ----------
function sekmeSec(program) {
  $('sekmeKontrol').setAttribute('aria-selected', String(!program));
  $('sekmeProgram').setAttribute('aria-selected', String(program));
  $('ana').hidden = program;
  $('programGorunum').hidden = !program;
  try { localStorage.setItem('varcomex.sekme', program ? 'program' : 'kontrol'); } catch (e) { /* yok say */ }
}

// ---------- metin ----------
function kuralHedefMetni(k) {
  if (k.eylem !== 'ac') return '';
  if (k.cihaz === 'kombi') {
    if (k.tur === 'konfor') {
      const d = Math.min(prgKonfor + k.fark, 26);
      return ` konfor${k.fark >= 0 ? '+' : '−'}${Math.abs(k.fark)} (${d}°)`;
    }
    return ` ${k.derece}°`;
  }
  return ` ${k.mod === 'isitma' ? 'ısıtma' : 'soğutma'} ${k.derece}°`;
}

function kuralMetni(k, gunlerle) {
  const cihaz = k.cihaz === 'kombi' ? 'Kombi' : 'Klima';
  const eylem = k.eylem === 'ac' ? 'aç' : 'kapat';
  let gun = '';
  if (gunlerle) {
    if (k.gun === 127) gun = 'Her gün';
    else if (k.gun === 31) gun = 'Hafta içi';
    else if (k.gun === 96) gun = 'Hafta sonu';
    else gun = GUNLER.filter((_, i) => k.gun & (1 << i)).join(' ');
    gun += ' · ';
  }
  return `${gun}${k.saat} ${cihaz} ${eylem}${kuralHedefMetni(k)}`;
}

function olayMetni(o) {
  if (!o) return '—';
  const cihaz = o.cihaz === 'kombi' ? 'kombi' : 'klima';
  return `${o.gun} ${o.saat} ${cihaz} ${o.eylem === 'ac' ? 'aç' : 'kapat'}${o.eylem === 'ac' && o.derece != null ? ' ' + o.derece + '°' : ''}`;
}

// ---------- çizim ----------
function programSatirCiz() {
  const p = durum && durum.program;
  const satir = $('programSatir');
  if (!p) { satir.hidden = true; return; }
  satir.hidden = false;
  if (p.durum === 'saat_yok') satir.textContent = 'Program: beynin saati bilinmiyor, program çalışmıyor';
  else if (p.durum === 'duraklatildi') satir.textContent = 'Program duraklatıldı';
  else if (p.durum === 'bos') satir.textContent = 'Program: kural yok';
  else satir.textContent = 'Sıradaki: ' + olayMetni(p.sonraki);
}

function programCiz() {
  programSatirCiz();
  const p = durum && durum.program;
  const DURUM = { acik: 'Açık', duraklatildi: 'Duraklatıldı', saat_yok: 'Saat yok', bos: 'Kural yok' };
  $('prgDurum').textContent = p ? (DURUM[p.durum] || '—') : '—';
  $('prgSonraki').textContent = p
    ? (p.durum === 'saat_yok' ? 'Beynin saati bilinmiyor (internet yok): program çalışmıyor.'
      : `Sıradaki: ${olayMetni(p.sonraki)}${p.son ? ' · Son: ' + olayMetni(p.son) : ''}`)
    : 'Sıradaki: —';

  const acik = kontrolAcik();
  const duraklat = prgSunucu ? !!prgSunucu.duraklat : false;
  const dd = $('prgDuraklat');
  if (!prgDurBekleyen) {
    dd.textContent = duraklat ? 'Programa devam et' : 'Programı duraklat (tatil)';
    dd.disabled = !acik || !prgSunucu;
  }

  // haftalık özet
  const hafta = $('prgHafta');
  hafta.textContent = '';
  for (let g = 0; g < 7; g++) {
    const satir = document.createElement('div');
    satir.className = 'hafta-gun';
    const ad = document.createElement('strong');
    ad.textContent = GUNLER[g];
    const olaylar = document.createElement('div');
    olaylar.className = 'hafta-olaylar';
    const gunun = prgTaslak.filter((k) => k.gun & (1 << g)).sort((a, b) => a.saat.localeCompare(b.saat));
    if (!gunun.length) { const b = document.createElement('span'); b.className = 'kucuk'; b.textContent = '—'; olaylar.append(b); }
    for (const k of gunun) {
      const o = document.createElement('span');
      o.className = 'olay' + (k.etkin === false ? ' pasif' : '');
      o.textContent = kuralMetni(k, false);
      olaylar.append(o);
    }
    satir.append(ad, olaylar);
    hafta.append(satir);
  }

  // kural listesi
  const liste = $('prgListe');
  liste.textContent = '';
  prgTaslak.forEach((k, i) => {
    const li = document.createElement('li');
    if (k.etkin === false) li.className = 'pasif';
    const m = document.createElement('span');
    m.className = 'kural-metin';
    m.textContent = kuralMetni(k, true) + (k.etkin === false ? ' (pasif)' : '');
    const duz = document.createElement('button');
    duz.type = 'button'; duz.textContent = 'Düzenle';
    duz.addEventListener('click', () => kuralAc(i));
    const sil = document.createElement('button');
    sil.type = 'button'; sil.textContent = 'Sil'; sil.setAttribute('aria-label', 'Kuralı sil: ' + m.textContent);
    sil.addEventListener('click', () => { prgTaslak.splice(i, 1); prgKirli = true; programCiz(); });
    li.append(m, duz, sil);
    liste.append(li);
  });
  $('prgBos').hidden = prgTaslak.length > 0;
  $('prgAdet').textContent = `${prgTaslak.length} / ${PRG_MAX}`;
  $('prgEkle').disabled = prgTaslak.length >= PRG_MAX;
  if (document.activeElement !== $('prgKonfor')) $('prgKonfor').value = prgKonfor;
  $('prgTaslak').hidden = !prgKirli;
  const k = $('prgKaydet');
  if (!prgBekleyen) {
    k.textContent = 'Kaydet';
    k.disabled = !acik || !prgKirli;
  }
}

// ---------- beyinden program/durum ----------
function programMesaj(metin) {
  let p;
  try { p = JSON.parse(metin); } catch (e) { uyariGoster('Beyinden okunamayan program durumu geldi.'); return; }
  prgSunucu = p;
  if (prgBekleyen && p.id === prgBekleyen.id) {
    clearTimeout(prgBekleyen.zamanlayici);
    prgBekleyen = null;
    if (p.sonuc === 'ok') { prgKirli = false; uyariGoster('Program kaydedildi (beyin onayladı).', 4000); }
    else uyariGoster('Program kaydedilmedi: ' + (p.mesaj || 'beyin reddetti') + '. Beyindeki eski program duruyor.', 10000);
  }
  if (prgDurBekleyen && !!p.duraklat === prgDurBekleyen.deger) {
    clearTimeout(prgDurBekleyen.zamanlayici);
    prgDurBekleyen = null;
  }
  if (!prgKirli) {                 // düzenleme yoksa beyindekini göster
    prgTaslak = kopya(p.kurallar || []);
    if (Number.isInteger(p.konfor)) prgKonfor = p.konfor;
  }
  programCiz();
}

// ---------- kaydet / duraklat ----------
function programKaydet() {
  if (!istemci || !brokerBagli) { uyariGoster('Sunucuya bağlı değil, program gönderilmedi.'); return; }
  if (beyinOnline === false) { uyariGoster('Beyin çevrimdışı, program gönderilmedi.'); return; }
  const konfor = parseInt($('prgKonfor').value, 10);
  if (!(konfor >= 15 && konfor <= 26)) { uyariGoster('Konfor sıcaklığı 15–26 olmalı.'); return; }
  prgKonfor = konfor;
  const id = Math.random().toString(16).slice(2, 10);
  const yuk = { id, konfor, kurallar: prgTaslak };
  const k = $('prgKaydet');
  k.disabled = true;
  k.textContent = 'Gönderiliyor…';
  prgBekleyen = {
    id,
    zamanlayici: setTimeout(() => {
      prgBekleyen = null;
      uyariGoster('Beyinden 5 sn içinde onay gelmedi: program kaydedilmemiş olabilir.', 8000);
      programCiz();
    }, YANIT_SURESI_MS),
  };
  istemci.publish(kok() + 'program/set', JSON.stringify(yuk), { qos: 1, retain: false }, (hata) => {
    if (hata) { clearTimeout(prgBekleyen.zamanlayici); prgBekleyen = null; uyariGoster('Gönderilemedi: ' + hata.message); programCiz(); }
  });
}

function programDuraklatDegistir() {
  if (!istemci || !brokerBagli || !prgSunucu) return;
  const deger = !prgSunucu.duraklat;
  const d = $('prgDuraklat');
  d.disabled = true;
  d.textContent = 'Gönderiliyor…';
  prgDurBekleyen = {
    deger,
    zamanlayici: setTimeout(() => { prgDurBekleyen = null; uyariGoster('Beyinden 5 sn içinde onay gelmedi.'); programCiz(); }, YANIT_SURESI_MS),
  };
  istemci.publish(kok() + 'program/duraklat', deger ? 'on' : 'off', { qos: 1, retain: false });
}

// ---------- kural düzenleme ----------
function gunDugmeleriKur() {
  const kap = $('kGunler');
  GUNLER.forEach((ad, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = ad;
    b.dataset.bit = String(i);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
    kap.append(b);
  });
  const fark = $('kFark');
  for (let n = -3; n <= 5; n++) {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = n === 0 ? 'konfor' : `konfor ${n > 0 ? '+' : '−'}${Math.abs(n)}`;
    fark.append(o);
  }
}

function kuralAlanlari() {
  const cihaz = $('kCihaz').value, ac = $('kEylem').value === 'ac';
  $('kKombiAlan').hidden = !(ac && cihaz === 'kombi');
  $('kKlimaAlan').hidden = !(ac && cihaz === 'klima');
  const konfor = $('kTur').value === 'konfor';
  $('kSabitEt').hidden = konfor;
  $('kFarkEt').hidden = !konfor;
}

function kuralAc(i) {
  kuralDuzenlenen = i;
  const k = i >= 0 ? prgTaslak[i]
    : { gun: 31, saat: '07:00', cihaz: 'kombi', eylem: 'ac', tur: 'sabit', derece: 22, etkin: true };
  $('kuralBaslik').textContent = i >= 0 ? 'Kuralı düzenle' : 'Yeni kural';
  for (const b of $('kGunler').children) b.setAttribute('aria-pressed', String(!!(k.gun & (1 << +b.dataset.bit))));
  $('kSaat').value = k.saat;
  $('kCihaz').value = k.cihaz;
  $('kEylem').value = k.eylem;
  $('kTur').value = k.tur || 'sabit';
  $('kKombiDerece').value = k.cihaz === 'kombi' && k.tur !== 'konfor' && k.derece ? k.derece : 22;
  $('kFark').value = String(k.fark != null ? k.fark : 0);
  $('kMod').value = k.mod || 'sogutma';
  $('kKlimaDerece').value = k.cihaz === 'klima' && k.derece ? k.derece : 24;
  $('kEtkin').checked = k.etkin !== false;
  $('kHata').hidden = true;
  kuralAlanlari();
  $('kuralDlg').showModal();
}

function kuralTamam(olay) {
  olay.preventDefault();
  const hata = (m) => { $('kHata').textContent = m; $('kHata').hidden = false; };
  let gun = 0;
  for (const b of $('kGunler').children) if (b.getAttribute('aria-pressed') === 'true') gun |= 1 << +b.dataset.bit;
  if (!gun) return hata('En az bir gün seç.');
  const saat = $('kSaat').value;
  if (!/^\d{2}:\d{2}$/.test(saat)) return hata('Saat SS:DD olmalı.');
  const k = { gun, saat, cihaz: $('kCihaz').value, eylem: $('kEylem').value, etkin: $('kEtkin').checked };
  if (k.eylem === 'ac' && k.cihaz === 'kombi') {
    k.tur = $('kTur').value;
    if (k.tur === 'sabit') {
      k.derece = parseInt($('kKombiDerece').value, 10);
      if (!(k.derece >= 15 && k.derece <= 28)) return hata('Kombi derecesi 15–28 olmalı.');
    } else {
      k.fark = parseInt($('kFark').value, 10);
    }
  } else if (k.eylem === 'ac') {
    k.mod = $('kMod').value;
    k.derece = parseInt($('kKlimaDerece').value, 10);
    if (!(k.derece >= 16 && k.derece <= 30)) return hata('Klima derecesi 16–30 olmalı.');
  }
  if (kuralDuzenlenen >= 0) prgTaslak[kuralDuzenlenen] = k;
  else prgTaslak.push(k);
  prgKirli = true;
  $('kuralDlg').close();
  programCiz();
}

function programBasla() {
  gunDugmeleriKur();
  $('sekmeKontrol').addEventListener('click', () => sekmeSec(false));
  $('sekmeProgram').addEventListener('click', () => sekmeSec(true));
  $('prgEkle').addEventListener('click', () => kuralAc(-1));
  $('prgKaydet').addEventListener('click', programKaydet);
  $('prgDuraklat').addEventListener('click', programDuraklatDegistir);
  $('prgKonfor').addEventListener('input', () => {
    const v = parseInt($('prgKonfor').value, 10);
    if (v >= 15 && v <= 26 && v !== prgKonfor) { prgKonfor = v; prgKirli = true; programCiz(); }
  });
  $('kCihaz').addEventListener('change', kuralAlanlari);
  $('kEylem').addEventListener('change', kuralAlanlari);
  $('kTur').addEventListener('change', kuralAlanlari);
  $('kuralForm').addEventListener('submit', kuralTamam);
  $('kIptal').addEventListener('click', () => $('kuralDlg').close());
  let sekme = 'kontrol';
  try { sekme = localStorage.getItem('varcomex.sekme') || 'kontrol'; } catch (e) { /* yok say */ }
  sekmeSec(sekme === 'program');
  programCiz();
}
