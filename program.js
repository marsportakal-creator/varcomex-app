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
const SEKMELER = { kontrol: ['sekmeKontrol', 'ana'], program: ['sekmeProgram', 'programGorunum'], kurallar: ['sekmeKurallar', 'kuralGorunum'] };
function sekmeSec(ad) {
  if (ad === true) ad = 'program';
  if (ad === false || !SEKMELER[ad]) ad = 'kontrol';
  for (const [k, [sekme, gorunum]] of Object.entries(SEKMELER)) {
    $(sekme).setAttribute('aria-selected', String(k === ad));
    $(gorunum).hidden = k !== ad;
  }
  try { localStorage.setItem('varcomex.sekme', ad); } catch (e) { /* yok say */ }
}
window.vcxSekme = sekmeSec;          // Android: Ayarlar > Kurallar kısayolu

// ---------- metin ----------
function kuralHedefMetni(k) {
  if (k.eylem !== 'ac') return '';
  if (k.cihaz === 'kombi') {
    if (k.tur === 'konfor') {
      const d = Math.min(prgKonfor + k.fark, 26);
      return ` konfor${k.fark >= 0 ? '+' : '−'}${Math.abs(k.fark)} (${d}°)`;
    }
    if (k.tur === 'oda') return ` oda${k.fark >= 0 ? '+' : '−'}${Math.abs(k.fark)}`;
    if (k.tur === 'varsayilan') return ' (kombi aç ayarı)';
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
  kurallarMesaj(p);
}

// ---------- kaydet / duraklat ----------
function programKaydet() {
  if ((!kopru && !istemci) || !brokerBagli) { uyariGoster('Sunucuya bağlı değil, program gönderilmedi.'); return; }
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
  yayinla('program/set', JSON.stringify(yuk), (hata) => {
    if (hata && prgBekleyen) { clearTimeout(prgBekleyen.zamanlayici); prgBekleyen = null; uyariGoster('Gönderilemedi: ' + hata); programCiz(); }
  });
}

function programDuraklatDegistir() {
  if ((!kopru && !istemci) || !brokerBagli || !prgSunucu) return;
  const deger = !prgSunucu.duraklat;
  const d = $('prgDuraklat');
  d.disabled = true;
  d.textContent = 'Gönderiliyor…';
  prgDurBekleyen = {
    deger,
    zamanlayici: setTimeout(() => { prgDurBekleyen = null; uyariGoster('Beyinden 5 sn içinde onay gelmedi.'); programCiz(); }, YANIT_SURESI_MS),
  };
  yayinla('program/duraklat', deger ? 'on' : 'off', (hata) => {
    if (hata && prgDurBekleyen) { clearTimeout(prgDurBekleyen.zamanlayici); prgDurBekleyen = null; uyariGoster('Gönderilemedi: ' + hata); programCiz(); }
  });
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
  farkSecenekleri($('kFark'), 'konfor');
}

function farkSecenekleri(sec, ad) {
  const v = sec.value;
  sec.textContent = '';
  for (let n = -3; n <= 5; n++) {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = n === 0 ? ad : `${ad} ${n > 0 ? '+' : '−'}${Math.abs(n)}`;
    sec.append(o);
  }
  if (v) sec.value = v;
}

function kuralAlanlari() {
  const cihaz = $('kCihaz').value, ac = $('kEylem').value === 'ac';
  $('kKombiAlan').hidden = !(ac && cihaz === 'kombi');
  $('kKlimaAlan').hidden = !(ac && cihaz === 'klima');
  const tur = $('kTur').value;
  $('kSabitEt').hidden = tur !== 'sabit';
  $('kFarkEt').hidden = tur !== 'konfor' && tur !== 'oda';
  $('kFarkYazi').textContent = tur === 'oda' ? 'Çalıştığı andaki oda sıcaklığına göre (−3 … +5)' : 'Konfora göre (−3 … +5, en fazla 26°)';
  farkSecenekleri($('kFark'), tur === 'oda' ? 'oda' : 'konfor');
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
  $('kKombiDerece').value = k.cihaz === 'kombi' && (k.tur || 'sabit') === 'sabit' && k.derece ? k.derece : 22;
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
    } else if (k.tur !== 'varsayilan') {
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
  $('sekmeKontrol').addEventListener('click', () => sekmeSec('kontrol'));
  $('sekmeProgram').addEventListener('click', () => sekmeSec('program'));
  $('sekmeKurallar').addEventListener('click', () => sekmeSec('kurallar'));
  kurallarBasla();
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
  sekmeSec(sekme);
  programCiz();
}

// ---------- Kurallar sekmesi (1.2.0) ----------
let krlBekleyen = null;    // { zamanlayici } program/kural ya da program/set onayı bekleniyor

function kosulMetni(k) {
  const esik = String(k.esik).replace('.', ',');
  const kosul = k.kosul === 'ustu' ? 'üstüne çıkarsa' : 'altına düşerse';
  let eylem = k.eylem === 'ac' ? 'aç' : 'kapat';
  if (k.eylem === 'ac' && k.hedef === 'sabit') eylem += ` ${k.derece}°`;
  if (k.eylem === 'ac' && k.hedef === 'oda') eylem += ` (oda${k.fark >= 0 ? '+' : '−'}${Math.abs(k.fark)})`;
  return `Oda ${esik}° ${kosul} → ${k.cihaz === 'kombi' ? 'kombi' : 'klima'} ${eylem}`;
}

function kurallarCiz() {
  const p = prgSunucu;
  const liste = $('krlListe');
  liste.textContent = '';
  const haftalik = (p && p.kurallar) || [];
  const kosul = (p && p.kosul) || [];
  const acik = kontrolAcik() && !krlBekleyen;
  const satir = (metin, etkin, degistir, sil) => {
    const li = document.createElement('li');
    if (!etkin) li.className = 'pasif';
    const m = document.createElement('span');
    m.className = 'kural-metin';
    m.textContent = metin + (etkin ? '' : ' (pasif)');
    const e = document.createElement('button');
    e.type = 'button'; e.textContent = etkin ? 'Durdur' : 'Etkinleştir'; e.disabled = !acik;
    e.addEventListener('click', degistir);
    const s = document.createElement('button');
    s.type = 'button'; s.textContent = 'Sil'; s.disabled = !acik; s.setAttribute('aria-label', 'Kuralı sil: ' + metin);
    s.addEventListener('click', () => { if (confirm('Silinsin mi?\n' + metin)) sil(); });
    li.append(m, e, s);
    liste.append(li);
  };
  haftalik.forEach((k, i) => satir(kuralMetni(k, true), k.etkin !== false,
    () => haftalikDegistir((l) => { l[i].etkin = l[i].etkin === false; }),
    () => haftalikDegistir((l) => { l.splice(i, 1); })));
  kosul.forEach((k) => satir(kosulMetni(k) + (k.kilitli ? ' · tetiklendi' : ''), k.etkin !== false,
    () => kuralGonder({ etkin: { id: k.id, deger: k.etkin === false } }),
    () => kuralGonder({ sil: k.id })));
  $('krlBos').hidden = haftalik.length + kosul.length > 0;
  $('krlAdet').textContent = p ? `haftalık ${haftalik.length} / ${PRG_MAX} · koşullu ${kosul.length} / 16` : '—';
  const a = (p && p.ayar) || null;
  if (a && document.activeElement !== $('krlAcFark') && document.activeElement !== $('krlAcTavan') && !krlBekleyen) {
    $('krlAcFark').value = String(a.ac_fark);
    $('krlAcTavan').value = a.ac_tavan;
  }
  $('krlAcKaydet').disabled = !acik || !a;
}

function krlBitir(mesaj) {
  if (krlBekleyen) { clearTimeout(krlBekleyen.zamanlayici); krlBekleyen = null; }
  if (mesaj) uyariGoster(mesaj, 4000);
  kurallarCiz();
}

function krlBekle() {
  krlBekleyen = { zamanlayici: setTimeout(() => { krlBekleyen = null; uyariGoster('Beyinden 5 sn içinde onay gelmedi.'); kurallarCiz(); }, YANIT_SURESI_MS) };
  kurallarCiz();
}

function kuralGonder(yuk) {
  if ((!kopru && !istemci) || !brokerBagli) { uyariGoster('Sunucuya bağlı değil.'); return; }
  krlBekle();
  yayinla('program/kural', JSON.stringify(yuk), (hata) => {
    if (hata) { krlBitir(); uyariGoster('Gönderilemedi: ' + hata); }
  });
}

// Haftalık liste beyindeki son haliyle değiştirilip tam liste gönderilir (Program sekmesindeki taslak etkilenmez)
function haftalikDegistir(f) {
  if (!prgSunucu) return;
  if (prgKirli) { uyariGoster('Program sekmesinde kaydedilmemiş değişiklik var: önce kaydedin ya da sayfayı yenileyin.', 8000); return; }
  if ((!kopru && !istemci) || !brokerBagli) { uyariGoster('Sunucuya bağlı değil.'); return; }
  const l = kopya(prgSunucu.kurallar || []);
  f(l);
  const id = Math.random().toString(16).slice(2, 10);
  krlBekle();
  krlBekleyen.id = id;
  yayinla('program/set', JSON.stringify({ id, konfor: prgSunucu.konfor, kurallar: l }), (hata) => {
    if (hata) { krlBitir(); uyariGoster('Gönderilemedi: ' + hata); }
  });
}

function kombiAcKaydet() {
  const fark = parseInt($('krlAcFark').value, 10);
  const tavan = parseInt($('krlAcTavan').value, 10);
  if (!(tavan >= 18 && tavan <= 30)) { uyariGoster('Üst sınır 18–30 olmalı.'); return; }
  kuralGonder({ ayar: { ac_fark: fark, ac_tavan: tavan } });
}

function kurallarBasla() {
  farkSecenekleri($('krlAcFark'), 'oda');
  $('krlAcKaydet').addEventListener('click', kombiAcKaydet);
}

// program/durum geldi: bekleyen kural işlemi tamam (program/kural onayı ayrı gelmez; liste yenilenir)
function kurallarMesaj(p) {
  if (krlBekleyen && (!krlBekleyen.id || p.id === krlBekleyen.id)) {
    const ok = !krlBekleyen.id || p.sonuc === 'ok';
    krlBitir(ok ? 'Kaydedildi (beyin onayladı).' : 'Kaydedilmedi: ' + (p.mesaj || 'beyin reddetti'));
  } else kurallarCiz();
}
