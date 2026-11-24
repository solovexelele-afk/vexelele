/* vexelele wallet — некастодиальный TON-кошелёк.
   Секретная фраза шифруется паролем (PBKDF2 + AES-GCM) и хранится только в этом браузере.
   Никуда, кроме блокчейна (подписанные переводы), данные не отправляются. */
(() => {
'use strict';
const TW = window.TonWeb, MN = TW && TW.mnemonic;
const app = document.getElementById('app');
const STORE = 'vxw', NET = 'vxw-net', LOCK_MS = 15 * 60 * 1000;

const S = {
  net: (() => { try { return localStorage.getItem(NET) || 'mainnet'; } catch (e) { return 'mainnet'; } })(),
  keyPair: null, wallet: null, raw: '', addr: '',
  balance: 0, rate: { usd: 0, uah: 0 }, jettons: [], events: [], tab: 'tokens',
  draft: null, newWords: null
};

/* ---------- helpers ---------- */
const $ = s => app.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeImg = u => /^https:\/\//.test(u || '') ? esc(u) : '';
const te = new TextEncoder(), td = new TextDecoder();
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const short = a => a ? a.slice(0, 6) + '…' + a.slice(-6) : '';
const fmt = (n, d = 4) => (+n).toLocaleString('ru', { maximumFractionDigits: d });
const api = () => S.net === 'testnet' ? 'https://testnet.tonapi.io' : 'https://tonapi.io';
let tt;
function toast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 1800);
}
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) { const a = document.createElement('textarea'); a.value = text; document.body.append(a); a.select(); document.execCommand('copy'); a.remove(); }
  toast(msg || 'Скопировано ✓');
}
/* Копирование сид-фразы: через минуту пробуем очистить буфер обмена */
let clipTimer;
async function copySeed(words) {
  await copy(words.join(' '), 'Фраза скопирована. Буфер очистится через минуту');
  clearTimeout(clipTimer);
  clipTimer = setTimeout(() => { navigator.clipboard?.writeText(' ').catch(() => {}); }, 60000);
}
async function get(path) {
  const r = await fetch(api() + path);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function loadStore() { try { return JSON.parse(localStorage.getItem(STORE)); } catch (e) { return null; } }

/* ---------- crypto ---------- */
async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptWords(words, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(words.join(' '))));
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}
async function decryptWords(pass) {
  const s = loadStore(); if (!s) throw new Error('no wallet');
  const key = await deriveKey(pass, unb64(s.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv) }, key, unb64(s.ct));
  return td.decode(pt).split(' ');
}

/* ---------- wallet ---------- */
async function openWallet(words) {
  const kp = await MN.mnemonicToKeyPair(words);
  const w = new TW.Wallets.all.v4R2(new TW.HttpProvider(), { publicKey: kp.publicKey, wc: 0 });
  const a = await w.getAddress();
  S.keyPair = kp; S.wallet = w; S.addrObj = a;
  setAddr();
}
function setAddr() {
  S.raw = S.addrObj.toString(false).toLowerCase();
  S.addr = S.addrObj.toString(true, true, false, S.net === 'testnet');
}
function lock() {
  if (S.keyPair) { S.keyPair.secretKey.fill(0); }
  S.keyPair = null; S.wallet = null; S.balance = 0; S.jettons = []; S.events = [];
  render('unlock');
}
let idle;
function bumpIdle() { clearTimeout(idle); if (S.keyPair) idle = setTimeout(() => { lock(); toast('Кошелёк заблокирован'); }, LOCK_MS); }
['pointerdown', 'keydown'].forEach(e => addEventListener(e, bumpIdle, { passive: true }));

async function refresh() {
  if (!S.raw) return;
  const raw = encodeURIComponent(S.raw);
  const [acc, jet, ev, rate] = await Promise.allSettled([
    get(`/v2/accounts/${raw}`),
    get(`/v2/accounts/${raw}/jettons?currencies=usd`),
    get(`/v2/accounts/${raw}/events?limit=30`),
    S.net === 'mainnet' ? fetch('https://tonapi.io/v2/rates?tokens=ton&currencies=usd,uah').then(r => r.json()) : Promise.reject()
  ]);
  if (acc.status === 'fulfilled') { S.balance = Number(acc.value.balance) / 1e9; S.status = acc.value.status; }
  if (jet.status === 'fulfilled') S.jettons = (jet.value.balances || []).filter(j => j.balance !== '0');
  // спам-переводы с «наградами» и ссылками прячем
  if (ev.status === 'fulfilled') S.events = (ev.value.events || []).filter(e => !e.is_scam && !(e.actions || []).some(a => (a.TonTransfer || a.JettonTransfer || {}).sender?.is_scam));
  if (rate.status === 'fulfilled') { const p = rate.value.rates.TON.prices; S.rate = { usd: p.USD, uah: p.UAH }; }
  else if (S.net === 'testnet') S.rate = { usd: 0, uah: 0 };
  S.loaded = true;
  if (S.view === 'home') renderHome();
}

/* ---------- views ---------- */
function render(view, arg) {
  S.view = view;
  document.getElementById('net-badge').textContent = S.net;
  document.getElementById('net-badge').classList.toggle('test', S.net === 'testnet');
  (V[view] || V.welcome)(arg);
  scrollTo(0, 0);
}
const V = {};

V.welcome = () => {
  app.innerHTML = `<div class="view">
    <h1>Твой TON.<br><span>Твои ключи.</span></h1>
    <p class="muted">Кошелёк работает прямо в браузере. Секретная фраза шифруется твоим паролем и никуда не отправляется: ни мне, ни на сервер.</p>
    <button class="btn primary" id="b-new">Создать кошелёк</button>
    <button class="btn" id="b-imp">У меня уже есть кошелёк</button>
    <div class="note">Совет: сначала попробуй в <b>тестовой сети</b> (Настройки → Тестовая сеть), там TON бесплатные.</div>
    <button class="btn" id="b-net">${S.net === 'testnet' ? 'Перейти в основную сеть' : 'Включить тестовую сеть'}</button>
  </div>`;
  $('#b-new').onclick = async () => { S.newWords = await MN.generateMnemonic(); render('create'); };
  $('#b-imp').onclick = () => render('import');
  $('#b-net').onclick = () => { switchNet(); render('welcome'); };
};

V.create = () => {
  app.innerHTML = `<div class="view">
    <button class="back" id="b-back">← назад</button>
    <h2>Секретная фраза</h2>
    <p class="muted">Это 24 слова, которые и есть твой кошелёк. Запиши их на бумагу по порядку и храни в надёжном месте.</p>
    <div class="note"><b>Никому не показывай эти слова.</b> Кто знает фразу, тот владеет деньгами. Если потеряешь фразу и пароль, восстановить кошелёк не сможет никто.</div>
    <div class="words blur" id="words">${S.newWords.map((w, i) => `<div><i>${i + 1}</i>${esc(w)}</div>`).join('')}</div>
    <button class="btn" id="b-show">Показать слова</button>
    <button class="btn primary" id="b-next" disabled>Я записал(а) все 24 слова</button>
  </div>`;
  $('#b-back').onclick = () => { S.newWords = null; render('welcome'); };
  $('#b-show').onclick = () => {
    $('#words').classList.remove('blur'); $('#b-next').disabled = false;
    $('#b-show').textContent = 'Скопировать фразу';
    $('#b-show').onclick = () => copySeed(S.newWords);
  };
  $('#b-next').onclick = () => render('confirm');
};

V.confirm = () => {
  const idx = [];
  while (idx.length < 3) { const n = crypto.getRandomValues(new Uint32Array(1))[0] % 24; if (!idx.includes(n)) idx.push(n); }
  idx.sort((a, b) => a - b);
  app.innerHTML = `<div class="view">
    <button class="back" id="b-back">← к словам</button>
    <h2>Проверка</h2>
    <p class="muted">Введи слова под этими номерами, чтобы убедиться, что фраза записана верно.</p>
    ${idx.map(i => `<label class="field"><small class="lbl">Слово №${i + 1}</small><input data-i="${i}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`).join('')}
    <div class="err" id="err"></div>
    <button class="btn primary" id="b-ok">Проверить</button>
  </div>`;
  $('#b-back').onclick = () => render('create');
  $('#b-ok').onclick = () => {
    const ok = [...app.querySelectorAll('input[data-i]')].every(inp => inp.value.trim().toLowerCase() === S.newWords[+inp.dataset.i]);
    if (!ok) { $('#err').textContent = 'Слова не совпадают. Проверь, что записал(а) фразу правильно.'; return; }
    render('setpass', S.newWords);
  };
};

V.import = () => {
  app.innerHTML = `<div class="view">
    <button class="back" id="b-back">← назад</button>
    <h2>Импорт кошелька</h2>
    <p class="muted">Введи 24 слова секретной фразы через пробел. Фраза останется только в этом браузере.</p>
    <label class="field"><small class="lbl">Секретная фраза</small><textarea id="words" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="word1 word2 … word24"></textarea></label>
    <div class="err" id="err"></div>
    <button class="btn primary" id="b-ok">Продолжить</button>
  </div>`;
  $('#b-back').onclick = () => render('welcome');
  $('#b-ok').onclick = async () => {
    const words = $('#words').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length !== 24) { $('#err').textContent = `Нужно 24 слова, сейчас ${words.length}.`; return; }
    if (!(await MN.validateMnemonic(words))) { $('#err').textContent = 'Фраза не подходит. Проверь слова и их порядок.'; return; }
    $('#words').value = '';
    render('setpass', words);
  };
};

V.setpass = words => {
  app.innerHTML = `<div class="view">
    <h2>Пароль</h2>
    <p class="muted">Пароль защищает фразу в этом браузере. Он понадобится, чтобы открыть кошелёк и подтвердить перевод.</p>
    <label class="field"><small class="lbl">Пароль (минимум 8 символов)</small><input type="password" id="p1" autocomplete="new-password"></label>
    <label class="field"><small class="lbl">Повтори пароль</small><input type="password" id="p2" autocomplete="new-password"></label>
    <div class="err" id="err"></div>
    <button class="btn primary" id="b-ok">Готово</button>
  </div>`;
  $('#b-ok').onclick = async () => {
    const p1 = $('#p1').value, p2 = $('#p2').value;
    if (p1.length < 8) { $('#err').textContent = 'Пароль слишком короткий.'; return; }
    if (p1 !== p2) { $('#err').textContent = 'Пароли не совпадают.'; return; }
    $('#b-ok').disabled = true; $('#b-ok').textContent = 'Шифрую…';
    const enc = await encryptWords(words, p1);
    await openWallet(words);
    enc.pub = TW.utils.bytesToHex(S.keyPair.publicKey);
    try { localStorage.setItem(STORE, JSON.stringify(enc)); }
    catch (e) { $('#err').textContent = 'Браузер не даёт сохранить данные (приватный режим?).'; return; }
    words.fill(''); S.newWords = null;
    bumpIdle(); render('home'); refresh();
  };
};

V.unlock = () => {
  app.innerHTML = `<div class="view">
    <h1>С возвращением</h1>
    <p class="muted">Введи пароль, чтобы открыть кошелёк.</p>
    <label class="field"><small class="lbl">Пароль</small><input type="password" id="p" autocomplete="current-password"></label>
    <div class="err" id="err"></div>
    <button class="btn primary" id="b-ok">Открыть</button>
    <button class="btn danger" id="b-forgot">Забыл(а) пароль</button>
  </div>`;
  const go = async () => {
    $('#b-ok').disabled = true;
    try { const w = await decryptWords($('#p').value); await openWallet(w); bumpIdle(); render('home'); refresh(); }
    catch (e) { $('#err').textContent = 'Неверный пароль.'; $('#b-ok').disabled = false; }
  };
  $('#b-ok').onclick = go;
  $('#p').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#p').focus();
  $('#b-forgot').onclick = () => render('reset');
};

V.reset = () => {
  app.innerHTML = `<div class="view">
    <button class="back" id="b-back">← назад</button>
    <h2>Удалить кошелёк с этого устройства</h2>
    <div class="note">Пароль восстановить нельзя. Можно удалить кошелёк из браузера и заново импортировать его по <b>секретной фразе</b>. Без фразы доступ к деньгам будет потерян навсегда.</div>
    <label class="field"><small class="lbl">Напиши «удалить», чтобы подтвердить</small><input id="c" autocomplete="off"></label>
    <button class="btn danger" id="b-del">Удалить из браузера</button>
  </div>`;
  $('#b-back').onclick = () => render(S.keyPair ? 'settings' : 'unlock');
  $('#b-del').onclick = () => {
    if ($('#c').value.trim().toLowerCase() !== 'удалить') { toast('Напиши «удалить»'); return; }
    try { localStorage.removeItem(STORE); } catch (e) {}
    if (S.keyPair) S.keyPair.secretKey.fill(0);
    Object.assign(S, { keyPair: null, wallet: null, raw: '', addr: '', balance: 0, jettons: [], events: [] });
    render('welcome');
  };
};

function renderHome() {
  const fiat = S.rate.uah ? `≈ ${fmt(S.balance * S.rate.uah, 2)} ₴ · $${fmt(S.balance * S.rate.usd, 2)}` : (S.net === 'testnet' ? 'тестовые TON, без стоимости' : '');
  app.innerHTML = `<div class="view">
    <div class="balance">
      <small class="lbl">Баланс</small>
      <div class="amt">${S.loaded ? fmt(S.balance) : '…'}<span>TON</span></div>
      <div class="fiat">${fiat}</div>
      <button class="addr-chip" id="b-addr">${esc(short(S.addr))} <span>⧉</span></button>
    </div>
    <div class="actions">
      <button class="act" id="b-send"><b>↑</b>Отправить</button>
      <button class="act" id="b-recv"><b>↓</b>Получить</button>
      <button class="act" id="b-set"><b>⚙</b>Настройки</button>
    </div>
    <div class="tabs"><button data-t="tokens" class="${S.tab === 'tokens' ? 'on' : ''}">Активы</button><button data-t="history" class="${S.tab === 'history' ? 'on' : ''}">История</button></div>
    <div class="list" id="list"></div>
  </div>`;
  $('#b-addr').onclick = () => copy(S.addr, 'Адрес скопирован ✓');
  $('#b-send').onclick = () => { S.draft = null; render('send'); };
  $('#b-recv').onclick = () => render('receive');
  $('#b-set').onclick = () => render('settings');
  app.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { S.tab = b.dataset.t; renderHome(); });
  $('#list').innerHTML = S.tab === 'tokens' ? tokensHtml() : historyHtml();
  app.querySelectorAll('.item.tap').forEach(el => el.onclick = () => { S.draft = null; render('send', el.dataset.asset); });
}
V.home = renderHome;

function tokensHtml() {
  const ton = `<div class="item tap" data-asset="TON"><div class="ico" style="background:#0098ea">◆</div><div class="mid"><b>Toncoin</b><small>TON</small></div>
    <div class="right">${fmt(S.balance)}<small>${S.rate.usd ? '$' + fmt(S.balance * S.rate.usd, 2) : ''}</small></div></div>`;
  const js = S.jettons.map(j => {
    const d = j.jetton.decimals ?? 9, amt = Number(j.balance) / 10 ** d, usd = j.price?.prices?.USD;
    const img = safeImg(j.jetton.image);
    return `<div class="item tap" data-asset="${esc(j.jetton.address)}"><div class="ico">${img ? `<img src="${img}" alt="" loading="lazy">` : esc((j.jetton.symbol || '?')[0])}</div>
      <div class="mid"><b>${esc(j.jetton.name)}</b><small>${esc(j.jetton.symbol)}</small></div>
      <div class="right">${fmt(amt)}<small>${usd ? '$' + fmt(amt * usd, 2) : ''}</small></div></div>`;
  }).join('');
  return ton + js;
}

function historyHtml() {
  if (!S.loaded) return '<div class="empty">Загружаю…</div>';
  if (!S.events.length) return '<div class="empty">Пока нет операций. Нажми «Получить», чтобы пополнить кошелёк.</div>';
  return S.events.map(e => {
    const a = e.actions?.[0]; if (!a) return '';
    const when = new Date(e.timestamp * 1000).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const pend = e.in_progress ? ' · в обработке' : '';
    const fail = a.status !== 'ok' ? ' · ошибка' : '';
    let title = a.simple_preview?.name || a.type, sub = a.simple_preview?.description || '', amount = '', cls = '', dir = '•';
    const t = a.TonTransfer || a.JettonTransfer;
    if (t) {
      const incoming = (t.recipient?.address || '').toLowerCase() === S.raw;
      const other = incoming ? t.sender : t.recipient;
      let otherAddr = other?.name || '';
      if (!otherAddr && other?.address) { try { otherAddr = short(new TW.utils.Address(other.address).toString(true, true, true, S.net === 'testnet')); } catch (x) { otherAddr = short(other.address); } }
      const val = a.TonTransfer ? Number(t.amount) / 1e9 : Number(t.amount) / 10 ** (t.jetton?.decimals ?? 9);
      const sym = a.TonTransfer ? 'TON' : (t.jetton?.symbol || '');
      title = incoming ? 'Получено' : 'Отправлено'; dir = incoming ? '↓' : '↑'; cls = incoming ? 'plus' : 'minus';
      amount = `${incoming ? '+' : '−'}${fmt(val)} ${esc(sym)}`;
      sub = (incoming ? 'от ' : 'кому ') + otherAddr + (t.comment ? ' · «' + t.comment + '»' : '');
    }
    return `<div class="item"><div class="ico ${cls === 'plus' ? 'in' : cls === 'minus' ? 'out' : ''}">${dir}</div>
      <div class="mid"><b>${esc(title)}${esc(pend + fail)}</b><small>${esc(sub)}</small></div>
      <div class="right"><span class="${cls}">${amount}</span><small>${esc(when)}</small></div></div>`;
  }).join('');
}

V.receive = () => {
  const link = `ton://transfer/${S.addr}`;
  let svg = '';
  if (window.qrcode) { const q = qrcode(0, 'M'); q.addData(link); q.make(); svg = q.createSvgTag({ cellSize: 8, margin: 0, scalable: true }); }
  app.innerHTML = `<div class="view">
    <button class="back" id="b-back">← назад</button>
    <h2>Получить TON</h2>
    <p class="muted">Отсканируй QR в другом кошельке или отправь адрес. Сюда можно присылать TON и токены сети TON${S.net === 'testnet' ? ' (только тестовая сеть!)' : ''}.</p>
    <div class="qr">${svg}</div>
    <div class="addr-full">${esc(S.addr)}</div>
    <button class="btn primary" id="b-copy">Скопировать адрес</button>
  </div>`;
  $('#b-back').onclick = () => render('home');
  $('#b-copy').onclick = () => copy(S.addr, 'Адрес скопирован ✓');
};

/* ---------- активы и переводы ---------- */
const JETTON_GAS = '0.05';   // уходит на газ токен-перевода, неизрасходованное возвращается
function assets() {
  return [{ id: 'TON', symbol: 'TON', name: 'Toncoin', balance: S.balance, decimals: 9, image: '' }]
    .concat(S.jettons.map(j => ({
      id: j.jetton.address, symbol: j.jetton.symbol || '?', name: j.jetton.name || '', decimals: j.jetton.decimals ?? 9,
      balance: Number(j.balance) / 10 ** (j.jetton.decimals ?? 9), units: j.balance,
      image: j.jetton.image, wallet: j.wallet_address?.address
    })));
}
function toUnits(str, dec) {
  const [i, f = ''] = str.split('.');
  return new TW.utils.BN((i + f.padEnd(dec, '0').slice(0, dec)).replace(/^0+(?=\d)/, ''));
}
async function buildTransfer(d, secretKey, seqno) {
  if (d.asset === 'TON') {
    return S.wallet.methods.transfer({
      secretKey, toAddress: d.to, amount: d.all ? 0 : TW.utils.toNano(d.amount),
      seqno, payload: d.comment || '', sendMode: d.all ? 128 : 3   // 128 = отправить весь баланс, комиссия из него
    }).getQuery();
  }
  const a = assets().find(x => x.id === d.asset);
  const C = TW.boc.Cell, body = new C();
  body.bits.writeUint(0x0f8a7ea5, 32);                 // jetton transfer
  body.bits.writeUint(0, 64);                          // query_id
  body.bits.writeCoins(toUnits(d.amount, a.decimals));
  body.bits.writeAddress(new TW.utils.Address(d.to)); // получатель
  body.bits.writeAddress(S.addrObj);                   // сдача газа возвращается мне
  body.bits.writeBit(0);                               // без custom_payload
  body.bits.writeCoins(new TW.utils.BN(1));            // 1 нанотон: минимум, чтобы получатель увидел перевод
  if (d.comment) { const cm = new C(); cm.bits.writeUint(0, 32); cm.bits.writeString(d.comment); body.bits.writeBit(1); body.refs.push(cm); }
  else body.bits.writeBit(0);
  const jw = new TW.utils.Address(a.wallet).toString(true, true, true, S.net === 'testnet');
  return S.wallet.methods.transfer({ secretKey, toAddress: jw, amount: TW.utils.toNano(JETTON_GAS), seqno, payload: body, sendMode: 3 }).getQuery();
}

V.send = preset => {
  const d = S.draft || { asset: preset || 'TON' };
  const list = assets();
  const cur = list.find(x => x.id === d.asset) || list[0];
  app.innerHTML = `<div class="view">
    <button class="back" id="b-back">← назад</button>
    <h2>Отправить</h2>
    <div class="field"><small class="lbl">Что отправить</small>
      <div class="assets">${list.map(x => `<button type="button" class="asset ${x.id === cur.id ? 'on' : ''}" data-id="${esc(x.id)}">
        <span class="ico sm">${safeImg(x.image) ? `<img src="${safeImg(x.image)}" alt="">` : x.id === 'TON' ? '◆' : esc(x.symbol[0])}</span>
        <span><b>${esc(x.symbol)}</b><small>${fmt(x.balance)}</small></span></button>`).join('')}</div>
    </div>
    <label class="field"><small class="lbl">Адрес получателя</small><input id="to" value="${esc(d.to || '')}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="UQ… или EQ…"></label>
    <label class="field"><small class="lbl">Сумма, ${esc(cur.symbol)} · доступно ${fmt(cur.balance, cur.decimals)} <button type="button" id="b-max" style="color:var(--acc);margin-left:6px">всё</button></small><input id="amt" inputmode="decimal" value="${esc(d.amount || '')}" placeholder="0"></label>
    <label class="field"><small class="lbl">Комментарий (необязательно, виден всем)</small><input id="cmt" value="${esc(d.comment || '')}" maxlength="120"></label>
    ${cur.id !== 'TON' ? `<p class="muted" style="font-size:13px">Для перевода ${esc(cur.symbol)} нужно ~${JETTON_GAS} TON на балансе. Реально спишется намного меньше, остальное сразу вернётся.</p>` : ''}
    <div class="err" id="err"></div>
    <button class="btn primary" id="b-next">Далее</button>
  </div>`;
  let all = !!d.all;
  const keep = () => ({ to: $('#to').value.trim(), amount: $('#amt').value.trim(), comment: $('#cmt').value });
  app.querySelectorAll('.asset').forEach(b => b.onclick = () => { S.draft = { ...keep(), amount: '', asset: b.dataset.id }; V.send(); });
  $('#b-back').onclick = () => { S.draft = null; render('home'); };
  $('#amt').oninput = () => { all = false; };
  $('#b-max').onclick = () => {
    $('#amt').value = cur.id === 'TON' ? String(cur.balance) : (cur.units ? String(Number(cur.units) / 10 ** cur.decimals) : '0');
    all = cur.id === 'TON';
  };
  $('#b-next').onclick = () => {
    const { to, comment } = keep(), amount = $('#amt').value.trim().replace(',', '.');
    const err = m => { $('#err').textContent = m; };
    if (!TW.utils.Address.isValid(to)) return err('Неверный адрес. Проверь, что это адрес в сети TON.');
    const A = new TW.utils.Address(to);
    if (A.isUserFriendly && A.isTestOnly !== (S.net === 'testnet')) return err(S.net === 'testnet' ? 'Это адрес основной сети, а кошелёк в тестовой.' : 'Это адрес тестовой сети. В основной сети на него отправлять нельзя.');
    if (A.toString(false).toLowerCase() === S.raw) return err('Это твой собственный адрес.');
    const re = new RegExp(`^\\d+(\\.\\d{1,${cur.decimals}})?$`);
    if (!re.test(amount) || !(Number(amount) > 0)) return err(`Введи сумму, например 1.5 (до ${cur.decimals} знаков после точки).`);
    if (cur.id === 'TON') {
      if (Number(amount) > cur.balance) return err('Недостаточно TON.');
    } else {
      if (toUnits(amount, cur.decimals).gt(new TW.utils.BN(cur.units))) return err(`Недостаточно ${cur.symbol}.`);
      if (S.balance < +JETTON_GAS) return err(`Нужно хотя бы ${JETTON_GAS} TON на комиссию. Пополни TON.`);
    }
    S.draft = { asset: cur.id, symbol: cur.symbol, to, amount, comment, all: all && cur.id === 'TON' && Number(amount) === cur.balance };
    render('confirmSend');
  };
};

V.confirmSend = () => {
  const d = S.draft, isTon = d.asset === 'TON';
  const uah = v => S.rate.uah ? ` (≈ ${fmt(v * S.rate.uah, 2)} ₴)` : '';
  app.innerHTML = `<div class="view">
    <button class="back" id="b-back">← изменить</button>
    <h2>Подтверди перевод</h2>
    <div class="sum">
      <div><span>Кому</span><span>${esc(d.to)}</span></div>
      <div><span>${d.all ? 'Отправляешь' : 'Сумма'}</span><span>${d.all ? 'весь баланс, ' : ''}${esc(d.amount)} ${esc(d.symbol)}${isTon ? uah(+d.amount) : ''}</span></div>
      ${d.comment ? `<div><span>Комментарий</span><span>${esc(d.comment)}</span></div>` : ''}
      <div><span>Комиссия сети</span><span id="fee">считаю…</span></div>
      <div><span>${d.all ? 'Получатель получит' : 'Всего спишется'}</span><span id="total">—</span></div>
      <div><span>Сеть</span><span>${S.net}</span></div>
    </div>
    <div class="note">Переводы в блокчейне <b>нельзя отменить</b>. Проверь адрес ещё раз.</div>
    <label class="field"><small class="lbl">Пароль для подтверждения</small><input type="password" id="p" autocomplete="current-password"></label>
    <div class="err" id="err"></div>
    <button class="btn primary" id="b-go">Отправить ${esc(d.amount)} ${esc(d.symbol)}</button>
  </div>`;
  $('#b-back').onclick = () => render('send');
  estimateFee(d).then(fee => {
    if (S.view !== 'confirmSend') return;
    $('#fee').textContent = `${fmt(fee, 6)} TON${uah(fee)}`;
    if (d.all) $('#total').textContent = `${fmt(Math.max(0, +d.amount - fee), 6)} TON`;
    else if (isTon) $('#total').textContent = `${fmt(+d.amount + fee, 6)} TON${uah(+d.amount + fee)}`;
    else $('#total').textContent = `${esc(d.amount)} ${d.symbol} + ${fmt(fee, 6)} TON`;
    const need = isTon ? (d.all ? fee : +d.amount + fee) : Math.max(fee, +JETTON_GAS);
    if (need > S.balance) { $('#err').textContent = 'С учётом комиссии не хватает TON. Уменьши сумму или нажми «всё».'; $('#b-go').disabled = true; }
  }).catch(() => { if (S.view === 'confirmSend') { $('#fee').textContent = isTon ? 'обычно 0.0005–0.005 TON' : 'обычно 0.002–0.02 TON'; $('#total').textContent = `${esc(d.amount)} ${esc(d.symbol)} + комиссия`; } });
  $('#b-go').onclick = async () => {
    $('#b-go').disabled = true;
    try { await decryptWords($('#p').value); }
    catch (e) { $('#err').textContent = 'Неверный пароль.'; $('#b-go').disabled = false; return; }
    sendNow();
  };
};

async function getSeqno() {
  try { return (await get(`/v2/wallet/${encodeURIComponent(S.raw)}/seqno`)).seqno || 0; }
  catch (e) { if (String(e.message).includes('404')) return 0; throw e; }
}

/* Комиссия: перевод с пустой подписью прогоняется в эмуляторе TonAPI.
   Настоящий ключ для этого не используется и никуда не уходит. */
async function estimateFee(d) {
  const seqno = await getSeqno();
  const q = await buildTransfer(d, null, seqno);
  const boc = TW.utils.bytesToBase64(await q.toBoc(false));
  const need = d.asset === 'TON' ? +d.amount : +JETTON_GAS;
  const balance = Math.round((d.all ? S.balance : Math.max(S.balance, need + 1)) * 1e9);
  const r = await fetch(api() + '/v2/wallet/emulate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boc, params: [{ address: S.raw, balance }] })
  });
  if (!r.ok) throw new Error('emulate ' + r.status);
  const j = await r.json();
  let extra = Number(j.event?.extra);
  if (!Number.isFinite(extra)) throw new Error('no fee');
  // для «весь баланс» extra включает отправленную сумму — берём комиссию из трейса
  if (d.all) extra = -Number(j.trace?.transaction?.total_fees || 0);
  return Math.max(0, -extra) / 1e9;
}

async function sendNow() {
  const d = S.draft;
  app.innerHTML = `<div class="view status"><div class="spin"></div><h2>Отправляю…</h2><p class="muted" id="st">Подписываю перевод</p></div>`;
  const st = m => { const el = document.getElementById('st'); if (el) el.textContent = m; };
  try {
    const raw = encodeURIComponent(S.raw);
    const seqno = await getSeqno();
    const cell = await buildTransfer(d, S.keyPair.secretKey, seqno);
    const boc = TW.utils.bytesToBase64(await cell.toBoc(false));
    st('Отправляю в сеть');
    const r = await fetch(api() + '/v2/blockchain/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boc }) });
    if (!r.ok) throw new Error('Сеть отклонила перевод (' + r.status + ')');
    st('Жду подтверждения сети (обычно 5–15 секунд)');
    let done = false;
    for (let i = 0; i < 30 && !done; i++) {
      await new Promise(res => setTimeout(res, 2000));
      try { const s2 = (await get(`/v2/wallet/${raw}/seqno`)).seqno; if (s2 > seqno) done = true; } catch (e) {}
    }
    S.draft = null;
    app.innerHTML = `<div class="view status"><div class="big">${done ? '✓' : '…'}</div>
      <h2>${done ? 'Отправлено' : 'Перевод отправлен в сеть'}</h2>
      <p class="muted">${done ? `${esc(d.amount)} ${esc(d.symbol)} ушли на ${esc(short(d.to))}.` : 'Подтверждение задерживается. Проверь историю через минуту.'}</p>
      <button class="btn primary" id="b-home">К кошельку</button></div>`;
    $('#b-home').onclick = () => { render('home'); refresh(); };
  } catch (e) {
    app.innerHTML = `<div class="view status"><div class="big" style="color:var(--down)">×</div><h2>Не получилось</h2>
      <p class="muted">${esc(e.message || e)}</p><button class="btn primary" id="b-back">Назад</button></div>`;
    $('#b-back').onclick = () => render('confirmSend');
  }
}

V.settings = () => {
  app.innerHTML = `<div class="view">
    <button class="back" id="b-back">← назад</button>
    <h2>Настройки</h2>
    <div class="list">
      <button class="setting" id="b-net"><span>Тестовая сеть</span><span class="switch ${S.net === 'testnet' ? 'on' : ''}"></span></button>
      <button class="setting" id="b-phrase"><span>Показать секретную фразу</span><span class="muted">→</span></button>
      <button class="setting" id="b-lock"><span>Заблокировать</span><span class="muted">→</span></button>
      <button class="setting" id="b-del"><span style="color:var(--down)">Удалить кошелёк с устройства</span><span class="muted">→</span></button>
    </div>
    <p class="muted" style="font-size:13px">Кошелёк автоматически блокируется через 15 минут без действий. Тип кошелька: v4R2.</p>
  </div>`;
  $('#b-back').onclick = () => render('home');
  $('#b-net').onclick = () => { switchNet(); render('settings'); refresh(); };
  $('#b-phrase').onclick = () => render('phrase');
  $('#b-lock').onclick = lock;
  $('#b-del').onclick = () => render('reset');
};

V.phrase = () => {
  app.innerHTML = `<div class="view">
    <button class="back" id="b-back">← назад</button>
    <h2>Секретная фраза</h2>
    <div class="note"><b>Убедись, что никто не смотрит на экран.</b> Никому не отправляй фразу и не вставляй её на сайты. Поддержка никогда её не спрашивает. Если копируешь, вставь сразу в надёжное место.</div>
    <label class="field"><small class="lbl">Пароль</small><input type="password" id="p" autocomplete="current-password"></label>
    <div class="err" id="err"></div>
    <button class="btn primary" id="b-ok">Показать</button>
    <div id="out"></div>
  </div>`;
  $('#b-back').onclick = () => render('settings');
  $('#b-ok').onclick = async () => {
    try {
      const w = await decryptWords($('#p').value);
      $('#out').innerHTML = `<div class="words">${w.map((x, i) => `<div><i>${i + 1}</i>${esc(x)}</div>`).join('')}</div>
        <button class="btn" id="b-copy" style="margin-top:12px">Скопировать фразу</button>`;
      $('#b-copy').onclick = () => copySeed(w);
      $('#b-ok').remove(); $('#err').textContent = '';
      setTimeout(() => { if (S.view === 'phrase') render('settings'); }, 60000);
    } catch (e) { $('#err').textContent = 'Неверный пароль.'; }
  };
};

function switchNet() {
  S.net = S.net === 'testnet' ? 'mainnet' : 'testnet';
  try { localStorage.setItem(NET, S.net); } catch (e) {}
  if (S.addrObj) setAddr();
  S.balance = 0; S.jettons = []; S.events = []; S.loaded = false;
}

/* ---------- start ---------- */
if (!TW || !MN || !window.crypto?.subtle) {
  app.innerHTML = '<div class="view"><h2>Не удалось загрузить кошелёк</h2><p class="muted">Обнови страницу. Если не помогает, открой сайт в Chrome, Safari или Firefox по адресу https://…</p></div>';
  return;
}
if (location.hostname === 'localhost') window.__vxw = { S, refresh, render };
render(loadStore() ? 'unlock' : 'welcome');
setInterval(() => { if (S.view === 'home' && S.keyPair) refresh(); }, 20000);
})();
