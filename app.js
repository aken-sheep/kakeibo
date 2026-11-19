// ふたりの家計簿 — GitHub Pages + Firebase 版
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit,
  onSnapshot, getDocs, writeBatch, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- constants ---------- */
const ROOM_KEY = 'futari-kakeibo.room';
const SALT = 'futari-kakeibo-v1';
const CAT_COLORS = ['#1d6a55','#2f7fb8','#c0612b','#7a5bb0','#b8862f','#3a9a8c','#a8476b','#5d7a2f','#4f5fa8','#8a6a52','#4a8f5b','#9a5a2a'];
const DEFAULT_SETTINGS = {
  takeHome: 340000, nisa: 20000, startDay: 1, startMonth: null,
  people: { a: '夫', b: '妻' },
  categories: [
    { id: 'rent', name: '家賃', budget: 90000, fixed: true, personal: false },
    { id: 'food', name: '食費', budget: 45000, fixed: false, personal: false },
    { id: 'car', name: 'カーシェア', budget: 40000, fixed: false, personal: false },
    { id: 'util', name: '水道光熱費', budget: 30000, fixed: false, personal: false },
    { id: 'fun', name: '娯楽費・交際費', budget: 30000, fixed: false, personal: true },
    { id: 'daily', name: '日用品・服・美容', budget: 25000, fixed: false, personal: false },
    { id: 'safety', name: '保険・医療・予備費', budget: 20000, fixed: false, personal: false },
    { id: 'phone', name: '通信費', budget: 13000, fixed: true, personal: false },
    { id: 'subs', name: 'サブスク', budget: 10000, fixed: true, personal: false },
    { id: 'special', name: '特別費', budget: 10000, fixed: false, personal: false }
  ],
  fixedOverrides: {}
};
const CAR_PRICE = { h6: 4290, h12: 5500, h24: 6600, night: 2640, per15: 220, km: 20 };

/* ---------- state ---------- */
const st = {
  screen: 'boot', // boot | config | join | app
  uid: null, room: null, roomData: null,
  settings: clone(DEFAULT_SETTINGS), settingsSaved: false,
  expenses: [], loading: true, note: '',
  tab: 'home', period: null,
  input: { cat: null, amount: '', payer: null, date: null, note: '' },
  hist: { cat: 'all', payer: 'all' },
  car: { h6: 4, h12: 0, h24: 0, night: 0, shortH: 3, km: 0 },
  join: { busy: false, error: '', confirmCreate: null }
};
let fb = null; // {auth, db}
let unsubs = [];
function clone(o) { return JSON.parse(JSON.stringify(o)); }
const S = () => st.settings;
const mySlot = () => (st.roomData && st.roomData.slots && st.roomData.slots[st.uid]) || null;

/* ---------- utils ---------- */
const pad = n => String(n).padStart(2, '0');
const fmt = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => fmt(new Date());
const yen = n => (Math.round(Number(n) || 0)).toLocaleString('ja-JP') + '円';
const man = n => { const v = (Number(n) || 0) / 10000; return (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + '万'; };
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; el.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return el;
}
function catById(id) { return S().categories.find(c => c.id === id); }
function catColor(id) { const i = S().categories.findIndex(c => c.id === id); return CAT_COLORS[(i < 0 ? 11 : i) % CAT_COLORS.length]; }
function personName(slot) { const p = S().people || {}; return (slot === 'a' ? p.a : slot === 'b' ? p.b : '') || (slot === 'a' ? '夫' : slot === 'b' ? '妻' : '未設定'); }

/* ---------- passphrase → room id ---------- */
function normPass(p) { return (p || '').normalize('NFKC').replace(/\s+/g, ''); }
async function roomIdFrom(pass) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(normPass(pass)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(SALT), iterations: 200000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function loadRoom() { try { return localStorage.getItem(ROOM_KEY); } catch (e) { return null; } }
function saveRoom(id) { try { id ? localStorage.setItem(ROOM_KEY, id) : localStorage.removeItem(ROOM_KEY); } catch (e) {} }

/* ---------- periods ---------- */
function keyOf(ds) {
  const [y, m, d] = ds.split('-').map(Number); const sd = S().startDay; let Y = y, M = m;
  if (d < sd) { M--; if (M < 1) { M = 12; Y--; } }
  return Y + '-' + pad(M);
}
function shiftKey(key, n) { let [Y, M] = key.split('-').map(Number); M += n; while (M > 12) { M -= 12; Y++; } while (M < 1) { M += 12; Y--; } return Y + '-' + pad(M); }
function rangeOf(key) { const [Y, M] = key.split('-').map(Number); const sd = S().startDay; return [new Date(Y, M - 1, sd), new Date(Y, M, sd - 1)]; }
function periodTitle(key) { const [Y, M] = key.split('-').map(Number); return Y + '年' + M + '月'; }
function periodRange(key) { const [s, e] = rangeOf(key); return (s.getMonth() + 1) + '/' + s.getDate() + ' 〜 ' + (e.getMonth() + 1) + '/' + e.getDate(); }
const curKey = () => keyOf(today());
const startMonth = () => S().startMonth || curKey();

/* ---------- normalize stored data ---------- */
function normSettings(raw) {
  const d = clone(DEFAULT_SETTINGS); if (!raw || typeof raw !== 'object') return d;
  const num = (v, f, min, max) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : f; };
  d.takeHome = num(raw.takeHome, d.takeHome, 0, 1e8);
  d.nisa = num(raw.nisa, d.nisa, 0, 1e7);
  d.startDay = num(raw.startDay, 1, 1, 28);
  d.startMonth = typeof raw.startMonth === 'string' && /^\d{4}-\d{2}$/.test(raw.startMonth) ? raw.startMonth : null;
  if (raw.people && typeof raw.people === 'object') d.people = { a: String(raw.people.a || '夫').slice(0, 12), b: String(raw.people.b || '妻').slice(0, 12) };
  if (Array.isArray(raw.categories) && raw.categories.length) {
    d.categories = raw.categories.filter(c => c && typeof c.id === 'string').slice(0, 30).map(c => ({
      id: c.id.slice(0, 40), name: String(c.name || '項目').slice(0, 20), budget: num(c.budget, 0, 0, 1e8), fixed: !!c.fixed, personal: !!c.personal }));
  }
  if (raw.fixedOverrides && typeof raw.fixedOverrides === 'object') {
    d.fixedOverrides = {};
    for (const k in raw.fixedOverrides) {
      if (!/^\d{4}-\d{2}$/.test(k)) continue; const o = raw.fixedOverrides[k]; if (!o || typeof o !== 'object') continue;
      d.fixedOverrides[k] = {}; for (const c in o) { const v = Number(o[c]); if (Number.isFinite(v)) d.fixedOverrides[k][c] = Math.max(0, Math.round(v)); }
    }
  }
  return d;
}
function normExpense(id, x) {
  if (!x || typeof x !== 'object') return null;
  const amount = Number(x.amount);
  if (!Number.isFinite(amount) || typeof x.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) return null;
  return { id, date: x.date, amount: Math.round(amount), cat: String(x.cat || ''), payer: x.payer === 'b' ? 'b' : 'a', note: String(x.note || '').slice(0, 60), createdAt: Number(x.createdAt) || 0 };
}

/* ---------- computations ---------- */
function compute(key) {
  const s = S(); const active = key >= startMonth();
  const exps = st.expenses.filter(e => keyOf(e.date) === key);
  const ov = (s.fixedOverrides || {})[key] || {};
  const cats = s.categories.map(c => {
    const mine = exps.filter(e => e.cat === c.id);
    const manual = mine.reduce((a, e) => a + e.amount, 0);
    const fixedAmt = c.fixed && active ? (ov[c.id] != null ? ov[c.id] : c.budget) : 0;
    const by = { a: 0, b: 0 }; mine.forEach(e => by[e.payer] += e.amount);
    return { ...c, spent: manual + fixedAmt, manual, fixedAmt, by };
  });
  const other = exps.filter(e => !catById(e.cat)).reduce((a, e) => a + e.amount, 0);
  const spent = cats.reduce((a, c) => a + c.spent, 0) + other;
  const budget = s.categories.reduce((a, c) => a + c.budget, 0);
  const payers = { a: 0, b: 0 }; exps.forEach(e => payers[e.payer] += e.amount);
  return { key, cats, spent, budget, other, payers, exps, cash: s.takeHome - spent - s.nisa };
}

/* ---------- firebase ---------- */
const roomRef = id => doc(fb.db, 'households', id || st.room);
const settingsRef = id => doc(fb.db, 'households', id || st.room, 'meta', 'settings');
const expCol = id => collection(fb.db, 'households', id || st.room, 'expenses');

function boot() {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.apiKey || /ここに/.test(cfg.apiKey)) { st.screen = 'config'; render(); return; }
  const app = initializeApp(cfg);
  let db;
  try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }) }); }
  catch (e) { db = initializeFirestore(app, {}); }
  fb = { auth: getAuth(app), db };
  onAuthStateChanged(fb.auth, user => {
    if (!user) { signInAnonymously(fb.auth).catch(() => { st.screen = 'join'; st.join.error = 'ログインできませんでした。Firebaseで「匿名」ログインが有効になっているか確認してください。'; render(); }); return; }
    st.uid = user.uid;
    const saved = loadRoom();
    if (saved) enterRoom(saved); else { st.screen = 'join'; render(); }
  });
}

function stopListeners() { unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; }

function enterRoom(id) {
  stopListeners();
  st.room = id; st.screen = 'app'; st.loading = true; st.note = ''; st.expenses = []; st.roomData = null;
  st.settings = clone(DEFAULT_SETTINGS); st.settingsSaved = false; st.period = null;
  saveRoom(id);
  render(true);
  const timer = setTimeout(() => { if (st.loading) { st.note = '読み込みに時間がかかっています。電波の良いところで開き直してください。'; render(); } }, 10000);
  const fail = e => {
    clearTimeout(timer); st.loading = false;
    if (e && e.code === 'permission-denied') { leaveLocal('この家計簿に参加していません。合言葉を入れ直してください。'); return; }
    st.note = 'データを読み込めませんでした。時間をおいて開き直してください。'; render();
  };
  unsubs.push(onSnapshot(roomRef(id), snap => {
    if (!snap.exists()) { leaveLocal('この家計簿は削除されたか、合言葉が変わりました。新しい合言葉を入れてください。'); return; }
    const d = snap.data();
    if (!Array.isArray(d.members) || !d.members.includes(st.uid)) { leaveLocal('この家計簿のメンバーから外れました。合言葉をもう一度入れてください。'); return; }
    st.roomData = d; render();
  }, fail));
  unsubs.push(onSnapshot(settingsRef(id), snap => {
    st.settings = snap.exists() ? normSettings(snap.data()) : clone(DEFAULT_SETTINGS);
    st.settingsSaved = snap.exists(); render();
  }, fail));
  const now = new Date(); const since = fmt(new Date(now.getFullYear() - 1, now.getMonth() - 1, 1));
  unsubs.push(onSnapshot(query(expCol(id), where('date', '>=', since), orderBy('date', 'desc'), limit(1000)), q => {
    st.expenses = q.docs.map(d => normExpense(d.id, d.data())).filter(Boolean);
    if (!q.metadata.fromCache) { st.loading = false; clearTimeout(timer); if (/時間がかかって/.test(st.note)) st.note = ''; }
    render();
  }, fail));
}
function leaveLocal(msg) {
  stopListeners(); saveRoom(null);
  st.room = null; st.roomData = null; st.expenses = []; st.screen = 'join';
  st.join = { busy: false, error: msg || '', confirmCreate: null };
  render(true);
}

function writeErr(e) {
  if (e && e.code === 'permission-denied') toast('保存する権限がありません。合言葉を入れ直してください。');
  else toast('保存できませんでした。もう一度お試しください。');
}
// Firestore keeps writes locally while offline and sends them later, so writes are not awaited in the UI.
function saveSettings(next) {
  st.settings = normSettings(next); st.settingsSaved = true;
  setDoc(settingsRef(), clone(st.settings)).catch(writeErr);
  render();
}
function ensureSettings() { if (!st.settingsSaved) { const n = clone(S()); if (!n.startMonth) n.startMonth = curKey(); saveSettings(n); } }
function addExpense(e) {
  ensureSettings();
  const ref = doc(expCol());
  const body = { date: e.date, amount: Math.round(e.amount), cat: e.cat, payer: e.payer, note: e.note || '', createdAt: e.createdAt || Date.now() };
  setDoc(ref, body).catch(writeErr);
  return ref.id;
}
function updateExpense(id, e) {
  const cur = st.expenses.find(x => x.id === id) || {};
  setDoc(doc(expCol(), id), { date: e.date, amount: Math.round(e.amount), cat: e.cat, payer: e.payer, note: e.note || '', createdAt: cur.createdAt || Date.now() }).catch(writeErr);
}
function deleteExpense(id) { deleteDoc(doc(expCol(), id)).catch(writeErr); }
function setMySlot(slot) {
  updateDoc(roomRef(), { ['slots.' + st.uid]: slot }).catch(writeErr);
  st.input.payer = slot;
}

/* ---------- join / create ---------- */
async function tryJoin(pass, create) {
  const J = st.join;
  if (normPass(pass).length < 8) { J.error = '合言葉は8文字以上にしてください。'; render(true); return; }
  J.busy = true; J.error = ''; render(true);
  try {
    const id = await roomIdFrom(pass);
    const ref = roomRef(id);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      if (!create) { J.busy = false; J.confirmCreate = pass; render(true); return; }
      await setDoc(ref, { members: [st.uid], slots: {}, createdAt: Date.now() });
      J.busy = false; J.confirmCreate = null; enterRoom(id); toast('新しい家計簿を作りました。相手に同じ合言葉を伝えてください。'); return;
    }
    const d = snap.data();
    if (!(Array.isArray(d.members) && d.members.includes(st.uid))) {
      if ((d.members || []).length >= 2) { J.busy = false; J.error = 'この家計簿はすでに2人が使っています。入れない場合は、相手に設定から「相手を外す」を押してもらってください。'; render(true); return; }
      await updateDoc(ref, { members: arrayUnion(st.uid) });
      toast('家計簿に参加しました');
    }
    J.busy = false; enterRoom(id);
  } catch (e) {
    J.busy = false; J.error = e && e.code === 'permission-denied' ? '参加できませんでした。この家計簿はすでに2人が使っている可能性があります。' : '接続できませんでした。電波を確認してもう一度お試しください。';
    render(true);
  }
}

/* ---------- room management ---------- */
async function deleteRoomData(id) {
  const snap = await getDocs(expCol(id));
  let batch = writeBatch(fb.db); let n = 0;
  for (const d of snap.docs) { batch.delete(d.ref); if (++n >= 400) { await batch.commit(); batch = writeBatch(fb.db); n = 0; } }
  batch.delete(settingsRef(id));
  await batch.commit();
  const b2 = writeBatch(fb.db); b2.delete(roomRef(id)); await b2.commit();
}
async function changePass(newPass) {
  const oldId = st.room;
  const newId = await roomIdFrom(newPass);
  if (newId === oldId) throw new Error('same');
  const exists = await getDoc(roomRef(newId));
  if (exists.exists()) throw new Error('taken');
  const slot = mySlot();
  await setDoc(roomRef(newId), { members: [st.uid], slots: slot ? { [st.uid]: slot } : {}, createdAt: Date.now() });
  const all = await getDocs(expCol(oldId));
  let batch = writeBatch(fb.db); let n = 0;
  batch.set(settingsRef(newId), clone(S()));
  for (const d of all.docs) { batch.set(doc(expCol(newId), d.id), d.data()); if (++n >= 400) { await batch.commit(); batch = writeBatch(fb.db); n = 0; } }
  await batch.commit();
  stopListeners();
  await deleteRoomData(oldId);
  enterRoom(newId);
}
async function removePartner() {
  const slot = mySlot();
  await updateDoc(roomRef(), { members: [st.uid], slots: slot ? { [st.uid]: slot } : {} });
}
async function leaveRoom() {
  try { await updateDoc(roomRef(), { members: arrayRemove(st.uid) }); } catch (e) {}
  leaveLocal('この端末での共有をやめました。');
}

/* ---------- toast / modal ---------- */
let toastTimer = null;
function toast(msg, undo) {
  document.querySelectorAll('.toast').forEach(t => t.remove()); clearTimeout(toastTimer);
  const t = h('div', { class: 'toast', role: 'status' }, h('span', null, msg), undo ? h('button', { onclick: () => { t.remove(); undo(); } }, '取り消す') : null);
  document.body.append(t); toastTimer = setTimeout(() => t.remove(), undo ? 6000 : 4500);
}
function modal(build) {
  const close = () => { m.remove(); document.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
  const m = h('div', { class: 'modal', onclick: e => { if (e.target === m) close(); } }, sheet);
  build(sheet, close); document.body.append(m); document.addEventListener('keydown', esc);
  const f = sheet.querySelector('input,select,button'); if (f) f.focus();
}
function confirmBox(title, body, okLabel, onOk, danger) {
  modal((sh, close) => sh.append(h('div', { class: 'stack' }, h('h2', null, title), h('div', { class: 'small muted' }, body),
    h('button', { class: danger ? 'btn danger' : 'btn', onclick: () => { close(); onOk(); } }, okLabel),
    h('button', { class: 'btn ghost', onclick: close }, 'やめる'))));
}

/* ---------- icons ---------- */
const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
};
function renderTabs() {
  const nav = document.getElementById('nav'); nav.hidden = st.screen !== 'app';
  const tabs = [['home', 'ホーム', 'home'], ['history', '履歴', 'list'], ['input', '入力', 'plus'], ['report', 'レポート', 'chart'], ['settings', '設定', 'gear']];
  const box = document.getElementById('tabs'); box.replaceChildren();
  for (const [id, label, ic] of tabs) {
    const b = h('button', { 'aria-current': st.tab === id ? 'page' : null, 'aria-label': label, onclick: () => go(id) });
    if (id === 'input') b.append(h('span', { class: 'plus', html: ICON[ic] }), h('span', null, label));
    else b.append(h('span', { html: ICON[ic] }), h('span', null, label));
    box.append(b);
  }
}
function go(tab, opts) {
  st.tab = tab;
  if (tab === 'input') { st.input.cat = (opts && opts.cat) || null; st.input.amount = ''; st.input.note = ''; st.input.date = today(); st.input.payer = mySlot() || st.input.payer || 'a'; }
  render(true); window.scrollTo(0, 0);
}

/* ---------- render root ---------- */
const appEl = document.getElementById('app');
let lastView = null;
function render(force) {
  renderTabs();
  if (st.screen === 'config') { appEl.replaceChildren(viewConfig()); lastView = 'config'; return; }
  if (st.screen === 'join') { appEl.replaceChildren(viewJoin()); lastView = 'join'; return; }
  if (st.screen !== 'app') return;
  if (!st.period) st.period = curKey();
  if (st.tab === 'input' && lastView === 'input' && !force) { updateInputLive(); return; }
  if (st.tab === 'settings' && lastView === 'settings' && !force) { return; } // don't wipe unsaved edits
  lastView = st.tab;
  const views = { home: viewHome, history: viewHistory, input: viewInput, report: viewReport, settings: viewSettings };
  appEl.replaceChildren(...banners(), views[st.tab]());
}
function banners() {
  const out = [];
  if (st.note) out.push(h('div', { class: 'banner bad' }, st.note));
  if (st.roomData && !mySlot()) {
    out.push(h('div', { class: 'card stack' }, h('h2', null, 'あなたはどちらですか？'),
      h('div', { class: 'small muted' }, '支払った人の記録と、1人ずつの集計に使います。'),
      h('div', { class: 'two' }, h('button', { class: 'btn ghost', onclick: () => setMySlot('a') }, personName('a')), h('button', { class: 'btn ghost', onclick: () => setMySlot('b') }, personName('b')))));
  }
  return out;
}

/* ---------- CONFIG MISSING ---------- */
function viewConfig() {
  return h('div', { class: 'join' }, h('h1', null, 'ふたりの家計簿'),
    h('div', { class: 'banner bad' }, 'Firebaseの設定がまだ入っていません。firebase-config.js に、Firebaseコンソールの firebaseConfig を貼り付けてください(手順書のステップ4)。'));
}

/* ---------- JOIN ---------- */
function viewJoin() {
  const J = st.join;
  const inp = h('input', { id: 'pass', type: 'password', class: 'field', autocomplete: 'off', autocapitalize: 'off', placeholder: '例:ひがしやまと2027さくら',
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); tryJoin(inp.value, false); } } });
  const wrap = h('div', { class: 'join' },
    h('h1', null, 'ふたりの家計簿'),
    h('div', { class: 'lead' }, '2人だけで使う家計簿です。合言葉を入れると、同じ合言葉を知っている相手と共有できます(2人まで)。'));
  if (J.confirmCreate) {
    wrap.append(h('div', { class: 'card stack' },
      h('h2', null, 'この合言葉の家計簿はまだありません'),
      h('div', { class: 'small muted' }, '新しく作りますか？相手が先に作っている場合は、合言葉の入力ミスかもしれません。'),
      h('button', { class: 'btn', disabled: J.busy, onclick: () => tryJoin(J.confirmCreate, true) }, J.busy ? '作成中…' : '新しく作る'),
      h('button', { class: 'btn ghost', onclick: () => { J.confirmCreate = null; render(true); } }, '入力し直す')));
    return wrap;
  }
  const show = h('input', { id: 'showpw', type: 'checkbox', onchange: e => { inp.type = e.target.checked ? 'text' : 'password'; } });
  wrap.append(h('div', { class: 'card stack' },
    h('label', { class: 'f', for: 'pass' }, '合言葉(8文字以上)', inp),
    h('label', { class: 'showpw', for: 'showpw' }, show, '合言葉を表示する'),
    J.error ? h('div', { class: 'err', role: 'alert' }, J.error) : null,
    h('button', { class: 'btn', disabled: J.busy, onclick: () => tryJoin(inp.value, false) }, J.busy ? '確認中…' : 'はじめる / 参加する'),
    h('div', { class: 'small muted' }, '合言葉はこの端末にもサーバーにも保存しません。忘れないようにメモしておいてください。')));
  setTimeout(() => inp.focus(), 50);
  return wrap;
}

/* ---------- shared bits ---------- */
function periodNav() {
  const k = st.period;
  return h('div', { class: 'period' },
    h('button', { class: 'iconbtn', 'aria-label': '前の月', onclick: () => { st.period = shiftKey(k, -1); render(true); } }, '‹'),
    h('div', null, h('div', { class: 'title' }, periodTitle(k)), h('div', { class: 'range num' }, periodRange(k) + (k === curKey() ? '(今月)' : ''))),
    h('button', { class: 'iconbtn', 'aria-label': '次の月', onclick: () => { st.period = shiftKey(k, 1); render(true); } }, '›'));
}
function barEl(spent, budget, fixed) {
  const r = budget > 0 ? spent / budget : (spent > 0 ? 1.01 : 0);
  return h('div', { class: 'bar' }, h('i', { class: fixed ? (r > 1.001 ? 'warn' : null) : r > 1 ? 'over' : r > .85 ? 'warn' : null, style: 'width:' + Math.min(100, r * 100).toFixed(1) + '%' }));
}

/* ---------- HOME ---------- */
function viewHome() {
  const c = compute(st.period); const s = S(); const left = c.budget - c.spent;
  const hero = h('div', { class: 'card' },
    h('div', { class: 'hero' }, h('div', { class: 'small muted' }, 'この月あと使えるお金'), h('div', { class: 'big num' + (left < 0 ? ' neg' : '') }, yen(left)),
      barEl(c.spent, c.budget), h('div', { class: 'small muted num' }, '予算 ' + yen(c.budget) + ' のうち ' + yen(c.spent) + ' 使用')),
    h('div', { class: 'kv num' },
      h('div', null, h('span', null, '手取り'), h('b', null, man(s.takeHome))),
      h('div', null, h('span', null, 'NISA'), h('b', null, man(s.nisa))),
      h('div', null, h('span', null, '現金の貯金(見込み)'), h('b', { style: c.cash < 0 ? 'color:var(--bad)' : null }, man(c.cash)))));
  const list = h('div', { class: 'card', style: 'padding:4px 12px' });
  for (const cat of c.cats) {
    const l = cat.budget - cat.spent;
    list.append(h('button', { class: 'cat', onclick: () => cat.fixed ? editFixed(cat) : go('input', { cat: cat.id }) },
      h('div', { class: 'top' }, h('span', { class: 'name' }, cat.name, cat.fixed ? h('span', { class: 'chip' }, '固定・自動') : null, cat.personal ? h('span', { class: 'chip gray' }, '1人ずつ') : null),
        h('span', { class: 'num' }, h('b', null, yen(cat.spent)), h('span', { class: 'muted small' }, ' / ' + yen(cat.budget)))),
      barEl(cat.spent, cat.budget, cat.fixed),
      h('div', { class: 'left num' + (l < 0 && !cat.fixed ? ' over' : ' muted') }, cat.fixed ? (cat.manual ? '自動分 ' + yen(cat.fixedAmt) + ' + 追加 ' + yen(cat.manual) : '毎月自動で計上・タップでこの月の金額を変更') : (l < 0 ? yen(-l) + ' オーバー' : '残り ' + yen(l)))));
  }
  if (c.other) list.append(h('div', { class: 'cat' }, h('div', { class: 'top' }, h('span', { class: 'name' }, '削除された項目'), h('b', { class: 'num' }, yen(c.other)))));
  const ppl = h('div', { class: 'card stack' }, h('h2', null, '1人ずつ'));
  const grid = h('div', { class: 'people' });
  for (const slot of ['a', 'b']) {
    const p = h('div', { class: 'p stack', style: 'gap:6px' }, h('b', null, personName(slot)));
    for (const pc of c.cats.filter(x => x.personal)) {
      const allow = Math.round(pc.budget / 2); const used = pc.by[slot];
      p.append(h('div', { class: 'small' }, pc.name), barEl(used, allow), h('div', { class: 'small num' + (used > allow ? ' left over' : '') }, yen(used) + ' / ' + yen(allow)));
    }
    p.append(h('div', { class: 'small muted num' }, '支払い合計 ' + yen(c.payers[slot])));
    grid.append(p);
  }
  ppl.append(grid);
  return h('div', { class: 'stack' }, periodNav(), hero, h('h2', { style: 'margin-top:6px' }, '項目ごと'), list, ppl);
}
function editFixed(cat) {
  modal((sh, close) => {
    const k = st.period; const ov = ((S().fixedOverrides || {})[k] || {})[cat.id];
    const inp = h('input', { id: 'fixed-amt', type: 'number', inputmode: 'numeric', class: 'field num', value: String(ov != null ? ov : cat.budget) });
    sh.append(h('div', { class: 'stack' }, h('h2', null, cat.name + '(' + periodTitle(k) + ')'),
      h('div', { class: 'small muted' }, '固定費は毎月 ' + yen(cat.budget) + ' を自動で計上します。この月だけ金額が違うときに変更してください。毎月の金額は設定で変えられます。'),
      h('label', { class: 'f', for: 'fixed-amt' }, 'この月の金額', inp),
      h('button', { class: 'btn', onclick: () => {
        const n = clone(S()); n.fixedOverrides = n.fixedOverrides || {}; const v = Math.max(0, Math.round(Number(inp.value) || 0));
        n.fixedOverrides[k] = { ...(n.fixedOverrides[k] || {}) }; if (v === cat.budget) delete n.fixedOverrides[k][cat.id]; else n.fixedOverrides[k][cat.id] = v;
        if (!n.startMonth) n.startMonth = curKey(); close(); saveSettings(n); toast(cat.name + 'を ' + yen(v) + ' にしました');
      } }, '保存'),
      ov != null ? h('button', { class: 'btn ghost', onclick: () => { const n = clone(S()); delete n.fixedOverrides[k][cat.id]; close(); saveSettings(n); } }, 'いつもの金額に戻す') : null,
      h('button', { class: 'btn ghost', onclick: () => { close(); go('input', { cat: cat.id }); } }, '追加の支出として入力する')));
  });
}

/* ---------- INPUT ---------- */
let liveRecent = null, liveSend = null, liveRemain = null, liveGrid = null;
function viewInput() {
  const s = S(); const I = st.input;
  if (!I.payer) I.payer = mySlot() || 'a';
  const wrap = h('div', { class: 'stack' }, h('h2', null, '支出を入力'));
  liveGrid = h('div', { class: 'grid', role: 'group', 'aria-label': '項目' });
  wrap.append(liveGrid);
  const fixedSel = s.categories.filter(x => x.fixed);
  if (I.cat && catById(I.cat) && catById(I.cat).fixed) {
    wrap.append(h('label', { class: 'f', for: 'fixcat' }, '固定費の項目(自動計上分に上乗せされます)',
      h('select', { id: 'fixcat', class: 'field', onchange: e => { I.cat = e.target.value; updateInputLive(); } }, ...fixedSel.map(x => h('option', { value: x.id, selected: x.id === I.cat }, x.name)))));
  }
  const amt = h('input', { id: 'amt', type: 'text', inputmode: 'numeric', placeholder: '0', autocomplete: 'off', class: 'num', 'aria-label': '金額',
    oninput: e => { const v = e.target.value.replace(/[^\d]/g, ''); I.amount = v; e.target.value = v ? Number(v).toLocaleString('ja-JP') : ''; updateInputLive(); },
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } } });
  if (I.amount) amt.value = Number(I.amount).toLocaleString('ja-JP');
  wrap.append(h('div', { class: 'amount' }, amt, h('span', { style: 'font-weight:700' }, '円')));
  liveRemain = h('div', { class: 'small muted num', style: 'margin-top:-4px' }); wrap.append(liveRemain);
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '支払った人' });
  for (const slot of ['a', 'b']) seg.append(h('button', { 'aria-pressed': I.payer === slot ? 'true' : 'false', onclick: () => { I.payer = slot; seg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', (i === 0 ? 'a' : 'b') === slot ? 'true' : 'false')); } }, personName(slot) + 'が払った'));
  wrap.append(seg);
  wrap.append(h('div', { class: 'two' },
    h('label', { class: 'f', for: 'in-date' }, '日付', h('input', { id: 'in-date', type: 'date', value: I.date || today(), onchange: e => { I.date = e.target.value || today(); updateInputLive(); } })),
    h('label', { class: 'f', for: 'in-note' }, 'メモ(任意)', h('input', { id: 'in-note', type: 'text', maxlength: '40', value: I.note, placeholder: 'お店など', oninput: e => { I.note = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } } }))));
  liveSend = h('button', { class: 'btn', onclick: submit }); wrap.append(liveSend);
  liveRecent = h('div', { class: 'stack', style: 'gap:0' });
  wrap.append(h('h2', { style: 'margin-top:8px' }, '最近の入力'), h('div', { class: 'card', style: 'padding:2px 12px' }, liveRecent));
  setTimeout(updateInputLive, 0);
  return wrap;
}
function drawGrid() {
  const s = S(); const I = st.input; if (!liveGrid) return;
  const c = compute(keyOf(I.date || today()));
  liveGrid.replaceChildren();
  for (const cat of s.categories.filter(x => !x.fixed)) {
    const cc = c.cats.find(x => x.id === cat.id);
    liveGrid.append(h('button', { class: 'catbtn', 'aria-pressed': I.cat === cat.id ? 'true' : 'false', onclick: () => {
      const wasFixed = I.cat && catById(I.cat) && catById(I.cat).fixed; I.cat = cat.id;
      if (wasFixed) render(true); else updateInputLive();
      const a = document.getElementById('amt'); if (a) a.focus();
    } }, cat.name, h('small', { class: 'num' }, '残り' + man(cc.budget - cc.spent))));
  }
  const fixedSel = s.categories.filter(x => x.fixed);
  if (fixedSel.length) liveGrid.append(h('button', { class: 'catbtn', 'aria-pressed': I.cat && catById(I.cat) && catById(I.cat).fixed ? 'true' : 'false',
    onclick: () => { I.cat = fixedSel[0].id; render(true); } }, '固定費に追加', h('small', null, fixedSel.map(x => x.name).join('・'))));
}
function updateInputLive() {
  const I = st.input;
  drawGrid();
  if (liveSend) { const cat = catById(I.cat); const n = Number(I.amount) || 0; liveSend.disabled = !cat || !n; liveSend.textContent = cat && n ? cat.name + ' ' + yen(n) + ' を記録' : (cat ? '金額を入力してください' : '項目を選んでください'); }
  if (liveRemain) {
    const cat = catById(I.cat);
    if (cat) { const c = compute(keyOf(I.date || today())).cats.find(x => x.id === cat.id); const n = Number(I.amount) || 0; const after = c.budget - c.spent - n; liveRemain.textContent = cat.name + ':記録後の残り ' + yen(after) + (after < 0 ? '(オーバー)' : ''); liveRemain.style.color = after < 0 && !cat.fixed ? 'var(--bad)' : ''; }
    else liveRemain.textContent = '';
  }
  if (liveRecent) {
    liveRecent.replaceChildren(...st.expenses.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map(entRow));
    if (!st.expenses.length) liveRecent.append(h('div', { class: 'small muted', style: 'padding:12px 0' }, 'まだ記録がありません。'));
  }
}
function submit() {
  const I = st.input; const cat = catById(I.cat); const n = Number(I.amount) || 0;
  if (!cat || !n) return;
  const id = addExpense({ date: I.date || today(), amount: n, cat: cat.id, payer: I.payer || mySlot() || 'a', note: I.note.trim() });
  I.amount = ''; I.note = '';
  const amt = document.getElementById('amt'); if (amt) { amt.value = ''; amt.focus(); }
  const note = document.getElementById('in-note'); if (note) note.value = '';
  toast(cat.name + ' ' + yen(n) + ' を記録しました', () => { deleteExpense(id); toast('取り消しました'); });
  updateInputLive();
}

/* ---------- HISTORY ---------- */
function entRow(e) {
  const cat = catById(e.cat);
  return h('button', { class: 'ent', onclick: () => editExpense(e) },
    h('span', { class: 'dot', style: 'background:' + catColor(e.cat) }),
    h('div', { class: 'mid' }, h('div', null, (cat ? cat.name : '削除された項目') + (e.note ? '・' + e.note : '')), h('div', { class: 'small muted' }, Number(e.date.slice(5, 7)) + '/' + Number(e.date.slice(8)) + '・' + personName(e.payer))),
    h('span', { class: 'amt num' }, yen(e.amount)));
}
function viewHistory() {
  const H = st.hist; const c = compute(st.period);
  let list = c.exps.slice();
  if (H.cat !== 'all') list = list.filter(e => e.cat === H.cat);
  if (H.payer !== 'all') list = list.filter(e => e.payer === H.payer);
  list.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt);
  const filters = h('div', { class: 'two' },
    h('label', { class: 'f', for: 'h-cat' }, '項目', h('select', { id: 'h-cat', onchange: e => { H.cat = e.target.value; render(true); } }, h('option', { value: 'all' }, 'すべて'), ...S().categories.map(x => h('option', { value: x.id, selected: H.cat === x.id }, x.name)))),
    h('label', { class: 'f', for: 'h-pay' }, '支払った人', h('select', { id: 'h-pay', onchange: e => { H.payer = e.target.value; render(true); } }, h('option', { value: 'all' }, '2人とも'), ...['a', 'b'].map(s => h('option', { value: s, selected: H.payer === s }, personName(s))))));
  const total = list.reduce((a, e) => a + e.amount, 0);
  const card = h('div', { class: 'card', style: 'padding:4px 12px' });
  let lastDay = '';
  for (const e of list) {
    if (e.date !== lastDay) { lastDay = e.date; const d = new Date(e.date + 'T00:00'); card.append(h('div', { class: 'day' }, (d.getMonth() + 1) + '月' + d.getDate() + '日(' + '日月火水木金土'[d.getDay()] + ')')); }
    card.append(entRow(e));
  }
  if (!list.length) card.append(h('div', { class: 'small muted', style: 'padding:14px 0' }, 'この月の記録はありません。固定費は自動で計上されるので、ここには出ません。'));
  return h('div', { class: 'stack' }, periodNav(), filters, h('div', { class: 'row between' }, h('span', { class: 'small muted' }, list.length + '件(手入力分)'), h('b', { class: 'num' }, yen(total))), card);
}
function editExpense(e) {
  modal((sh, close) => {
    const f = { ...e };
    const seg = h('div', { class: 'seg' }, ...['a', 'b'].map(slot => h('button', { 'aria-pressed': f.payer === slot ? 'true' : 'false', onclick: () => { f.payer = slot; seg.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-pressed', (j === 0 ? 'a' : 'b') === slot ? 'true' : 'false')); } }, personName(slot))));
    sh.append(h('div', { class: 'stack' }, h('h2', null, '記録を直す'),
      h('div', { class: 'two' },
        h('label', { class: 'f', for: 'e-amt' }, '金額', h('input', { id: 'e-amt', type: 'number', inputmode: 'numeric', class: 'num', value: String(f.amount), oninput: ev => { f.amount = Math.max(0, Math.round(Number(ev.target.value) || 0)); } })),
        h('label', { class: 'f', for: 'e-cat' }, '項目', h('select', { id: 'e-cat', onchange: ev => { f.cat = ev.target.value; } }, ...S().categories.map(c => h('option', { value: c.id, selected: c.id === f.cat }, c.name))))),
      h('div', { class: 'two' },
        h('label', { class: 'f', for: 'e-date' }, '日付', h('input', { id: 'e-date', type: 'date', value: f.date, onchange: ev => { f.date = ev.target.value || f.date; } })),
        h('label', { class: 'f', for: 'e-note' }, 'メモ', h('input', { id: 'e-note', type: 'text', maxlength: '40', value: f.note, oninput: ev => { f.note = ev.target.value; } }))),
      seg,
      h('button', { class: 'btn', onclick: () => { if (!f.amount) return; close(); updateExpense(e.id, f); toast('保存しました'); } }, '保存'),
      h('button', { class: 'btn danger', onclick: () => { close(); deleteExpense(e.id); toast('削除しました', () => addExpense(e)); } }, 'この記録を削除')));
  });
}

/* ---------- REPORT ---------- */
function viewReport() {
  const s = S(); const k = st.period; const c = compute(k);
  const wrap = h('div', { class: 'stack' }, periodNav());
  const keys = []; for (let i = 5; i >= 0; i--) keys.push(shiftKey(k, -i));
  const data = keys.map(x => ({ k: x, v: compute(x).spent }));
  const W = 340, H = 180, L = 8, R = 8, T = 22, B = 26; const max = Math.max(s.takeHome, ...data.map(d => d.v)) * 1.08 || 1;
  const bw = (W - L - R) / data.length; const y = v => T + (H - T - B) * (1 - v / max);
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="過去6ヶ月の支出">';
  svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '" stroke="var(--line)"/>';
  const ty = y(s.takeHome);
  svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + ty + '" y2="' + ty + '" stroke="var(--warn)" stroke-dasharray="4 4"/><text x="' + (W - R) + '" y="' + (ty - 5) + '" text-anchor="end">手取り ' + man(s.takeHome) + '</text>';
  data.forEach((d, i) => {
    const x = L + i * bw + bw * .2; const w = bw * .6; const yy = y(d.v); const cur = d.k === k;
    svg += '<rect x="' + x + '" y="' + yy + '" width="' + w + '" height="' + Math.max(0, H - B - yy) + '" rx="4" fill="var(--accent)" opacity="' + (cur ? 1 : .45) + '"/>';
    if (d.v > 0) svg += '<text class="val" x="' + (x + w / 2) + '" y="' + (yy - 5) + '" text-anchor="middle">' + man(d.v) + '</text>';
    svg += '<text x="' + (x + w / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + Number(d.k.slice(5)) + '月</text>';
  });
  svg += '</svg>';
  wrap.append(h('div', { class: 'card stack' }, h('h2', null, '支出の推移(固定費込み)'), h('div', { class: 'chart', html: svg })));
  const br = h('div', { class: 'card stack' }, h('h2', null, 'この月の内訳'));
  const tot = c.spent || 1;
  for (const x of c.cats.slice().sort((a, b) => b.spent - a.spent)) {
    br.append(h('div', { style: 'display:grid;gap:4px' },
      h('div', { class: 'row between small' }, h('span', null, h('span', { class: 'dot', style: 'display:inline-block;margin-right:6px;background:' + catColor(x.id) }), x.name), h('span', { class: 'num' }, yen(x.spent) + '(' + Math.round(x.spent / tot * 100) + '%)')),
      h('div', { class: 'bar' }, h('i', { style: 'width:' + (x.spent / tot * 100).toFixed(1) + '%;background:' + catColor(x.id) }))));
  }
  wrap.append(br, carCard(c), savingsCard());
  return wrap;
}
function carCard(c) {
  const car = c.cats.find(x => x.id === 'car') || c.cats.find(x => /カーシェア|車/.test(x.name));
  const C = st.car; const out = h('div', { class: 'num small' });
  const calc = () => {
    const total = C.h6 * CAR_PRICE.h6 + C.h12 * CAR_PRICE.h12 + C.h24 * CAR_PRICE.h24 + C.night * CAR_PRICE.night + Math.round(C.shortH * 4) * CAR_PRICE.per15 + (C.h12 + C.h24 + C.night) * C.km * CAR_PRICE.km;
    const budget = car ? car.budget : 0;
    out.replaceChildren(h('div', { class: 'row between' }, h('span', null, '試算の合計'), h('b', { style: 'font-size:18px' }, yen(total))),
      budget ? h('div', { class: total > budget ? 'left over' : 'muted' }, '予算 ' + yen(budget) + ' に対して ' + (total > budget ? yen(total - budget) + ' オーバー' : yen(budget - total) + ' 余る')) : null);
  };
  const field = (key, label, step) => { const id = 'car-' + key; return [h('label', { for: id }, label), h('input', { id, type: 'number', inputmode: 'decimal', min: '0', step: step || '1', class: 'field num', value: String(C[key]), oninput: e => { C[key] = Math.max(0, Number(e.target.value) || 0); calc(); } })]; };
  const card = h('div', { class: 'card stack' }, h('h2', null, 'カーシェア'),
    car ? h('div', { class: 'row between' }, h('span', null, 'この月の実費'), h('b', { class: 'num' }, yen(car.spent) + ' / ' + yen(car.budget))) : null,
    car ? barEl(car.spent, car.budget) : null,
    h('div', { class: 'small muted' }, '1ヶ月の使い方を入れると料金を試算します(タイムズカー ベーシック、税込)。6時間以内なら距離料金はかかりません。'),
    h('div', { class: 'calc small' },
      ...field('h6', '6時間パック(4,290円)の回数'), ...field('h12', '12時間パック(5,500円)の回数'), ...field('h24', '24時間パック(6,600円)の回数'),
      ...field('night', 'ナイトパック(2,640円)の回数'), ...field('shortH', 'ちょい乗りの合計時間(15分220円)', '0.25'), ...field('km', '12時間以上・ナイトの1回あたりの距離(km、20円/km)')),
    out);
  calc(); return card;
}
function savingsCard() {
  const s = S(); const start = startMonth(); const cur = curKey();
  const rows = []; let k = start; let cumN = 0, cumC = 0, guard = 0;
  while (k <= cur && guard < 120) { const c = compute(k); const proj = k === cur; if (!proj) { cumN += s.nisa; cumC += c.cash; } rows.push({ k, nisa: s.nisa, cash: c.cash, proj }); k = shiftKey(k, 1); guard++; }
  const tb = h('tbody');
  rows.slice().reverse().forEach(r => tb.append(h('tr', { class: r.proj ? 'proj' : null }, h('td', null, periodTitle(r.k).replace(/^\d+年/, '') + (r.proj ? '(見込み)' : '')), h('td', { class: 'num' }, yen(r.nisa)), h('td', { class: 'num', style: r.cash < 0 ? 'color:var(--bad)' : null }, yen(r.cash)))));
  return h('div', { class: 'card stack' }, h('h2', null, '貯金・NISA'),
    h('div', { class: 'kv num' },
      h('div', null, h('span', null, 'NISA累計'), h('b', null, yen(cumN))), h('div', null, h('span', null, '現金の貯金累計'), h('b', null, yen(cumC))), h('div', null, h('span', null, '合計'), h('b', null, yen(cumN + cumC)))),
    h('div', { class: 'small muted' }, '記録を始めた ' + periodTitle(start) + ' から、締まった月の分を足しています。現金の貯金は「手取り − 支出 − NISA」で計算します。'),
    h('div', { style: 'overflow-x:auto' }, h('table', null, h('thead', null, h('tr', null, h('th', null, '月'), h('th', null, 'NISA'), h('th', null, '現金の貯金'))), tb)));
}

/* ---------- SETTINGS ---------- */
function viewSettings() {
  const d = clone(S());
  const numF = (id, label, key, help) => h('label', { class: 'f', for: id }, label, h('input', { id, type: 'number', inputmode: 'numeric', class: 'num', value: String(d[key]), oninput: e => { d[key] = Math.max(0, Math.round(Number(e.target.value) || 0)); upd(); } }), help ? h('span', { class: 'small' }, help) : null);
  const total = h('div', { class: 'small num' });
  const upd = () => { const b = d.categories.reduce((a, c) => a + c.budget, 0); const left = d.takeHome - b - d.nisa; total.replaceChildren('予算の合計 ' + yen(b) + '・NISA ' + yen(d.nisa) + ' → 現金の貯金 ', h('b', { style: left < 0 ? 'color:var(--bad)' : null }, yen(left))); };
  const catBox = h('div');
  const drawCats = () => {
    catBox.replaceChildren(); d.categories.forEach((c, i) => {
      const id = 'sc' + i;
      catBox.append(h('div', { class: 'setcat' },
        h('input', { id: id + 'n', class: 'field', 'aria-label': '項目名', value: c.name, maxlength: '20', oninput: e => { c.name = e.target.value; } }),
        h('input', { id: id + 'b', class: 'field num', 'aria-label': c.name + 'の予算', type: 'number', inputmode: 'numeric', value: String(c.budget), oninput: e => { c.budget = Math.max(0, Math.round(Number(e.target.value) || 0)); upd(); } }),
        h('div', { class: 'opts' },
          h('label', { class: 'row', for: id + 'f' }, h('input', { id: id + 'f', type: 'checkbox', checked: c.fixed, onchange: e => { c.fixed = e.target.checked; } }), '固定費(毎月自動)'),
          h('label', { class: 'row', for: id + 'p' }, h('input', { id: id + 'p', type: 'checkbox', checked: c.personal, onchange: e => { c.personal = e.target.checked; } }), '1人ずつ(半分ずつ)'),
          h('button', { class: 'btn danger sm', style: 'margin-left:auto', onclick: () => { d.categories.splice(i, 1); drawCats(); upd(); } }, '削除'))));
    });
  };
  drawCats(); upd();
  const members = (st.roomData && st.roomData.members) || [];
  const partnerIn = members.length >= 2;
  return h('div', { class: 'stack' },
    h('h2', null, '設定'),
    h('div', { class: 'card stack' },
      numF('s-take', '2人の手取り(月)', 'takeHome', '住宅補助を含めた金額'),
      numF('s-nisa', 'NISAの積み立て(月)', 'nisa'),
      h('div', { class: 'two' },
        h('label', { class: 'f', for: 's-day' }, '月の始まりの日', h('input', { id: 's-day', type: 'number', inputmode: 'numeric', min: '1', max: '28', class: 'num', value: String(d.startDay), oninput: e => { d.startDay = Math.min(28, Math.max(1, Math.round(Number(e.target.value) || 1))); } }), h('span', { class: 'small' }, '1なら毎月1日〜月末')),
        h('label', { class: 'f', for: 's-start' }, '記録を始めた月', h('input', { id: 's-start', type: 'month', value: startMonth(), onchange: e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) d.startMonth = e.target.value; } }))),
      h('div', { class: 'two' },
        h('label', { class: 'f', for: 's-pa' }, '1人目の呼び名', h('input', { id: 's-pa', maxlength: '12', value: d.people.a, oninput: e => { d.people.a = e.target.value; } })),
        h('label', { class: 'f', for: 's-pb' }, '2人目の呼び名', h('input', { id: 's-pb', maxlength: '12', value: d.people.b, oninput: e => { d.people.b = e.target.value; } })))),
    h('div', { class: 'card stack' }, h('h2', null, '項目と予算'), catBox,
      h('button', { class: 'btn ghost sm', onclick: () => { d.categories.push({ id: 'c' + Date.now().toString(36), name: '新しい項目', budget: 0, fixed: false, personal: false }); drawCats(); upd(); } }, '項目を追加'), total),
    h('button', { class: 'btn', onclick: () => { if (!d.startMonth) d.startMonth = startMonth(); d.categories = d.categories.filter(c => c.name.trim()); saveSettings(d); toast('設定を保存しました'); render(true); } }, '設定を保存'),
    mySlot() ? h('div', { class: 'small muted' }, 'この端末では「' + personName(mySlot()) + '」として記録しています。', h('button', { class: 'btn ghost sm', style: 'margin-left:8px', onclick: () => { setMySlot(mySlot() === 'a' ? 'b' : 'a'); render(true); } }, '切り替える')) : null,
    h('div', { class: 'card stack' }, h('h2', null, '共有'),
      h('div', { class: 'small muted' }, 'メンバー:' + members.length + '人 / 2人' + (partnerIn ? '(2人で共有中)' : '(相手はまだ参加していません。同じ合言葉を伝えてください)')),
      h('button', { class: 'btn ghost', onclick: () => changePassDialog() }, '合言葉を変える(相手との共有をリセット)'),
      partnerIn ? h('button', { class: 'btn ghost', onclick: () => confirmBox('相手を外しますか？', '相手はこの家計簿を開けなくなります。同じ合言葉を入れれば、また参加できます。スマホを機種変更したときなどに使います。', '相手を外す', () => removePartner().then(() => toast('相手を外しました')).catch(writeErr)) }, '相手を外す') : null,
      h('button', { class: 'btn ghost', onclick: () => confirmBox('この端末で共有をやめますか？', 'データは消えません。合言葉を入れればまた参加できます。', 'やめる', leaveRoom) }, 'この端末で共有をやめる')),
    h('div', { class: 'card stack danger-zone' }, h('h2', null, 'すべて削除'),
      h('div', { class: 'small muted' }, '家計簿のデータをすべて消して、最初からやり直します。元に戻せません。'),
      h('button', { class: 'btn danger', onclick: () => confirmBox('本当にすべて削除しますか？', '2人分の記録と設定がすべて消えます。元に戻せません。', 'すべて削除する', async () => { const id = st.room; stopListeners(); try { await deleteRoomData(id); } catch (e) {} leaveLocal('家計簿を削除しました。'); }, true) }, '家計簿をすべて削除')));
}
function changePassDialog() {
  modal((sh, close) => {
    const p1 = h('input', { id: 'np1', type: 'password', class: 'field', autocomplete: 'off' });
    const p2 = h('input', { id: 'np2', type: 'password', class: 'field', autocomplete: 'off' });
    const err = h('div', { class: 'err', role: 'alert' });
    const btn = h('button', { class: 'btn', onclick: async () => {
      if (normPass(p1.value).length < 8) { err.textContent = '8文字以上にしてください。'; return; }
      if (normPass(p1.value) !== normPass(p2.value)) { err.textContent = '確認用の合言葉が一致しません。'; return; }
      btn.disabled = true; btn.textContent = '移しています…';
      try { await changePass(p1.value); close(); toast('合言葉を変えました。相手に新しい合言葉を伝えてください。'); }
      catch (e) { btn.disabled = false; btn.textContent = '変更する'; err.textContent = e && e.message === 'taken' ? 'その合言葉は使えません。別の合言葉にしてください。' : e && e.message === 'same' ? '今と同じ合言葉です。' : '変更できませんでした。電波を確認してもう一度お試しください。'; }
    } }, '変更する');
    sh.append(h('div', { class: 'stack' }, h('h2', null, '合言葉を変える'),
      h('div', { class: 'small muted' }, 'データは新しい合言葉の家計簿に移り、古い方は消えます。相手は締め出されるので、新しい合言葉を伝えてください。'),
      h('label', { class: 'f', for: 'np1' }, '新しい合言葉(8文字以上)', p1),
      h('label', { class: 'f', for: 'np2' }, 'もう一度入力', p2), err, btn,
      h('button', { class: 'btn ghost', onclick: close }, 'やめる')));
  });
}

/* ---------- start ---------- */
st.input.date = today();
boot();
