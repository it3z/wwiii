// WWIII online web client (Session 45). Plain JS + Canvas 2D, no libraries.
// The server runs the game's own simulation; this page only draws the shared state and sends orders.
'use strict';

// ==================== settings ====================
const CFG = window.WWIII_CONFIG || {};
const params = new URLSearchParams(location.search);
if (params.get('server')) localStorage.setItem('wwiii_server', params.get('server'));
if (params.has('resetserver')) localStorage.removeItem('wwiii_server');
const SERVER = params.get('server') || localStorage.getItem('wwiii_server') || CFG.server ||
  ((location.protocol === 'https:' ? 'wss://' : 'ws://') + (location.hostname || '127.0.0.1') + ':8080');
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const WORLD = { x: -1800, y: -900, w: 3600, h: 1800 };
const MOVE_MS = 1000;            // armies glide between two state messages

function token() {
  let t = localStorage.getItem('wwiii_token');
  if (!t || t.length < 16) {
    const a = new Uint8Array(18);
    (window.crypto || window.msCrypto).getRandomValues(a);
    t = Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('wwiii_token', t);
  }
  return t;
}
const TOKEN = token();

const $ = id => document.getElementById(id);
function show(id) {
  for (const s of ['menu', 'pick', 'loading', 'game']) $(s).classList.toggle('hidden', s !== id);
  screen = id;
}
let screen = 'menu';

// ==================== connection ====================
let ws = null;
let wsWanted = false;
let reconnectTimer = 0;
let room = null;                 // {id, name} while in a room
let inRoom = false;              // the room answered (pick or welcome)
let myNation = '';

function connect() {
  clearTimeout(reconnectTimer);
  wsWanted = true;
  try { ws = new WebSocket(SERVER); } catch (e) { setNet(false); scheduleReconnect(); return; }
  const sock = ws;
  sock.onopen = () => {
    if (sock !== ws) return;
    setNet(true);
    if (room) {
      inRoom = false;
      send({ t: 'join', room: room.id });
      send({ t: 'enter', token: TOKEN, name: playerName() });
    }
  };
  sock.onmessage = ev => {
    if (sock !== ws) return;
    let m = null;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    onMessage(m);
  };
  sock.onclose = () => {
    if (sock !== ws) return;
    setNet(false);
    if (wsWanted) scheduleReconnect();
  };
  sock.onerror = () => {};
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (screen === 'game') banner('انقطع الاتصال… إعادة المحاولة');
  reconnectTimer = setTimeout(connect, 1500);
}
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function setNet(on) {
  $('net').classList.toggle('on', on);
  $('serverLine').textContent = (on ? 'متصل بالخادم' : 'غير متصل') + ' — ' + SERVER;
  if (on) banner('');
}
function playerName() {
  const n = $('playerName').value.trim() || 'قائد';
  localStorage.setItem('wwiii_name', n);
  return n;
}

function onMessage(m) {
  switch (m.t) {
    case 'lobby': renderRooms(m.rooms || []); break;
    case 'created':
      renderRooms(m.rooms || []);
      enterRoom(m.room);
      break;
    case 'joining': break;
    case 'room': if (room) room.taken = m.taken || {}; break;
    case 'pick':
      inRoom = true;
      room.taken = m.taken || {};
      room.defeated = m.defeated || [];
      room.name = m.name || room.name;
      mapReady.then(showPick);
      break;
    case 'welcome':
      inRoom = true;
      myNation = m.nation;
      room.name = m.name || room.name;
      localStorage.setItem('wwiii_last', JSON.stringify({ id: room.id, name: room.name, nation: myNation }));
      history.replaceState(null, '', '#room=' + room.id);
      mapReady.then(() => { startGame(); applyState(m); });
      break;
    case 'state': if (screen === 'game') applyState(m); break;
    case 'order':
      if (m.ok) toast('تم إرسال الأمر'); else toast(m.text || 'تعذر تنفيذ الأمر');
      break;
    case 'error': onError(m); break;
  }
}

function onError(m) {
  if (m.code === 'taken' && screen === 'pick') { toast(m.text); send({ t: 'enter', token: TOKEN, name: playerName() }); return; }
  if (m.code === 'room' || m.code === 'room_start') {
    toast(m.text);
    leaveRoom(true);
    return;
  }
  if (m.code === 'room_down') { banner(m.text); return; }
  toast(m.text || 'خطأ');
}

// ==================== menu ====================
function renderRooms(list) {
  const box = $('rooms');
  box.textContent = '';
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = 'لا توجد غرف بعد. أنشئ غرفة وادعُ اللاعبين.';
    box.appendChild(d);
  }
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'room';
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = r.name;
    const who = document.createElement('div');
    who.className = 'who';
    const players = Object.keys(r.taken || {});
    who.textContent = players.length ? players.length + ' لاعب: ' + players.map(c => countryName(c)).join('، ') : 'لا لاعبين بعد';
    info.append(name, who);
    const b = document.createElement('button');
    b.textContent = 'دخول';
    b.className = 'primary';
    b.onclick = () => enterRoom({ id: r.id, name: r.name });
    row.append(info, b);
    box.appendChild(row);
  }
  const last = lastRoom();
  const found = last && list.some(r => r.id === last.id);
  $('resume').classList.toggle('hidden', !found);
  if (found) $('resumeBtn').textContent = 'متابعة مباراتك: ' + last.name + (last.nation ? ' (' + countryName(last.nation) + ')' : '');
}
function lastRoom() { try { return JSON.parse(localStorage.getItem('wwiii_last') || 'null'); } catch (e) { return null; } }

function enterRoom(r) {
  room = { id: r.id, name: r.name, taken: {} };
  inRoom = false;
  loading('جارٍ تحميل الخريطة وتجهيز الغرفة…');
  loadMap();
  send({ t: 'join', room: room.id });
  send({ t: 'enter', token: TOKEN, name: playerName() });
}
function leaveRoom(toMenu) {
  room = null;
  inRoom = false;
  myNation = '';
  selected = null;
  moveMode = false;
  history.replaceState(null, '', location.pathname + location.search);
  // A fresh lobby connection (the old one is bound to the room).
  if (ws) { const old = ws; ws = null; old.close(); }
  if (toMenu) show('menu');
  connect();
}
function loading(text) { $('loadingText').textContent = text; show('loading'); }

// ==================== nation choice ====================
function showPick() {
  if (!room) return;
  show('pick');
  $('pickTitle').textContent = 'اختر دولتك — ' + (room.name || '');
  $('nationSearch').value = '';
  renderNations();
}
function renderNations() {
  const q = $('nationSearch').value.trim();
  const box = $('nations');
  box.textContent = '';
  const codes = Object.keys(MAP.countries).sort((a, b) => countryName(a).localeCompare(countryName(b), 'ar'));
  for (const c of codes) {
    const name = countryName(c);
    if (q && !name.includes(q) && !c.toLowerCase().includes(q.toLowerCase())) continue;
    const b = document.createElement('button');
    b.className = 'nation';
    const img = document.createElement('img');
    img.src = 'flags/' + c + '.png';
    img.onerror = () => { img.style.visibility = 'hidden'; };
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = name;
    b.append(img, n);
    const takenBy = room.taken[c];
    const lost = (room.defeated || []).includes(c);
    if (takenBy !== undefined || lost) {
      b.disabled = true;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = lost ? 'هُزمت' : ('يلعبها ' + (takenBy || 'لاعب'));
      b.appendChild(tag);
    }
    b.onclick = () => {
      loading('جارٍ الدخول بدولة ' + name + '…');
      send({ t: 'enter', token: TOKEN, nation: c, name: playerName() });
    };
    box.appendChild(b);
  }
}

// ==================== map data ====================
let MAP = null;
let mapReady = null;
const earth = new Image();
let earthOk = false;
function loadMap() {
  if (mapReady) return mapReady;
  mapReady = (async () => {
    earth.onload = () => { earthOk = true; dirty = true; };
    earth.src = 'data/earth.jpg?v=1';
    const res = await fetch('data/map.json?v=1');
    if (!res.ok) throw new Error('map ' + res.status);
    const d = await res.json();
    for (const p of d.provinces) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      p.paths = p.p.map(f => {
        const path = new Path2D();
        for (let i = 0; i < f.length; i += 2) {
          const x = f[i], y = f[i + 1];
          if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        path.closePath();
        return path;
      });
      p.box = [x0, y0, x1, y1];
      delete p.p;
    }
    d.provById = {};
    for (const p of d.provinces) d.provById[p.id] = p;
    d.borderPath = new Path2D();
    for (const f of d.borders) {
      for (let i = 0; i < f.length; i += 2) {
        if (i === 0) d.borderPath.moveTo(f[i], f[i + 1]); else d.borderPath.lineTo(f[i], f[i + 1]);
      }
    }
    d.cities.sort((a, b) => (b.k - a.k) || (b.p - a.p));
    d.cityById = {};
    for (const c of d.cities) d.cityById[c.id] = c;
    const rgba = c => 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ',' + c[3] + ')';
    d.tintCss = d.tints.map(rgba);
    d.ownCss = rgba(d.own);
    d.enemyCss = rgba(d.enemy);
    d.allyCss = rgba(d.ally);
    MAP = d;
    return d;
  })();
  mapReady.catch(e => { toast('تعذر تحميل الخريطة'); console.error(e); });
  return mapReady;
}
function countryName(c) { return (MAP && MAP.countries[c] && MAP.countries[c].n) || c; }

// ==================== match state ====================
const armies = new Map();        // id -> army
let owners = {}, cityOwners = {}, wars = [], allies = [], enemies = new Set();
let gameTime = 0, speed = '', running = true;
let selected = null;             // army id
let moveMode = false;

function applyState(m) {
  const now = performance.now();
  const seen = m.full ? new Set() : null;
  for (const r of m.armies || []) {
    const id = r[0];
    if (seen) seen.add(id);
    let a = armies.get(id);
    if (!a) {
      a = { id, owner: r[1], x: r[2], y: r[3], fx: r[2], fy: r[3], tx: r[2], ty: r[3], t0: now };
      armies.set(id, a);
    } else {
      const cur = armyPos(a, now);
      a.fx = cur[0]; a.fy = cur[1]; a.t0 = now;
    }
    a.owner = r[1]; a.tx = r[2]; a.ty = r[3];
    a.icon = (m.icons || [])[r[4]] || a.icon || '';
    a.n = r[5]; a.dx = r[6]; a.dy = r[7]; a.flags = r[8];
  }
  if (seen) { for (const id of [...armies.keys()]) if (!seen.has(id)) armies.delete(id); }
  for (const id of m.gone || []) armies.delete(id);
  if (selected && !armies.has(selected)) select(null);
  owners = m.owners || {};
  cityOwners = m.cities || {};
  wars = m.wars || [];
  allies = m.allies || [];
  enemies = new Set();
  for (const w of wars) {
    if (w[0] === myNation) enemies.add(w[1]);
    else if (w[1] === myNation) enemies.add(w[0]);
  }
  const key = JSON.stringify([owners, wars, allies]);
  if (key !== lastOwnersKey) { lastOwnersKey = key; dirty = true; }
  gameTime = m.time || 0;
  speed = m.speed || '';
  running = m.running !== false;
  updateHud();
  if (selected) updatePanel();
  animating = true;
}
let lastOwnersKey = '';

function armyPos(a, now) {
  const k = Math.min(1, (now - a.t0) / MOVE_MS);
  return [a.fx + (a.tx - a.fx) * k, a.fy + (a.ty - a.fy) * k];
}
function ownerOf(pid) { return owners[pid] || MAP.provById[pid].c; }
function relation(nation) {
  if (nation === myNation) return 'own';
  if (enemies.has(nation)) return 'enemy';
  if (allies.includes(nation)) return 'ally';
  return 'other';
}

function updateHud() {
  $('myName').textContent = countryName(myNation);
  const f = $('myFlag');
  if (f.dataset.code !== myNation) { f.dataset.code = myNation; f.src = 'flags/' + myNation + '.png'; f.onerror = () => { f.style.visibility = 'hidden'; }; }
  const day = Math.floor(gameTime / 86400) + 1;
  const h = Math.floor((gameTime % 86400) / 3600), mi = Math.floor((gameTime % 3600) / 60);
  $('clock').textContent = 'اليوم ' + day + ' — ' + String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  $('speed').textContent = running ? speed : 'متوقفة';
}

// ==================== camera and drawing ====================
const canvas = $('map');
const ctx = canvas.getContext('2d');
const base = document.createElement('canvas');   // map layer, redrawn only when the view or owners change
const bctx = base.getContext('2d');
let W = 0, H = 0;
const cam = { x: 0, y: -300, s: 0.5 };
let dirty = true, animating = true;
let hits = [];                   // [{kind, id, x0, y0, x1, y1}] screen boxes of the last frame

function resize() {
  W = window.innerWidth; H = window.innerHeight;
  for (const c of [canvas, base]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  clampCam();
  dirty = true;
}
window.addEventListener('resize', resize);
function minScale() { return Math.max(W / WORLD.w, H / WORLD.h) * 0.9; }
function clampCam() {
  cam.s = Math.max(minScale(), Math.min(60, cam.s));
  const hw = W / 2 / cam.s, hh = H / 2 / cam.s;
  cam.x = Math.max(WORLD.x + Math.min(hw, WORLD.w / 2), Math.min(WORLD.x + WORLD.w - Math.min(hw, WORLD.w / 2), cam.x));
  cam.y = Math.max(WORLD.y + Math.min(hh, WORLD.h / 2), Math.min(WORLD.y + WORLD.h - Math.min(hh, WORLD.h / 2), cam.y));
}
const sx = x => (x - cam.x) * cam.s + W / 2;
const sy = y => (y - cam.y) * cam.s + H / 2;
const wx = px => (px - W / 2) / cam.s + cam.x;
const wy = py => (py - H / 2) / cam.s + cam.y;
function worldTransform(c) { c.setTransform(DPR * cam.s, 0, 0, DPR * cam.s, DPR * (W / 2 - cam.x * cam.s), DPR * (H / 2 - cam.y * cam.s)); }

function drawBase() {
  const c = bctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = '#163650';
  c.fillRect(0, 0, base.width, base.height);
  worldTransform(c);
  if (earthOk) c.drawImage(earth, WORLD.x, WORLD.y, WORLD.w, WORLD.h);
  const vx0 = wx(0), vy0 = wy(0), vx1 = wx(W), vy1 = wy(H);
  for (const p of MAP.provinces) {
    const b = p.box;
    if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
    const o = ownerOf(p.id);
    const rel = relation(o);
    c.fillStyle = rel === 'own' ? MAP.ownCss : rel === 'enemy' ? MAP.enemyCss : rel === 'ally' ? MAP.allyCss
      : MAP.tintCss[(MAP.countries[o] || { t: 0 }).t] || MAP.tintCss[0];
    for (const path of p.paths) c.fill(path);
    if (o !== p.c) {                 // occupied: a darker edge so captures stand out
      c.strokeStyle = 'rgba(0,0,0,0.35)';
      c.lineWidth = 1 / cam.s;
      for (const path of p.paths) c.stroke(path);
    }
  }
  c.strokeStyle = 'rgba(255,255,255,0.55)';
  c.lineWidth = 1.1 / cam.s;
  c.stroke(MAP.borderPath);
  // Country names when zoomed out.
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (cam.s < 3.5) {
    c.font = '600 ' + (cam.s < 1 ? 11 : 13) + 'px -apple-system, "Geeza Pro", sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const used = [];
    const codes = Object.keys(MAP.countries);
    for (const code of codes) {
      const k = MAP.countries[code];
      const x = sx(k.l[0]), y = sy(k.l[1]);
      if (x < -50 || x > W + 50 || y < -20 || y > H + 20) continue;
      const w = c.measureText(k.n).width;
      const box = [x - w / 2 - 4, y - 9, x + w / 2 + 4, y + 9];
      if (used.some(u => box[0] < u[2] && box[2] > u[0] && box[1] < u[3] && box[3] > u[1])) continue;
      used.push(box);
      c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,0.55)'; c.strokeText(k.n, x, y);
      c.fillStyle = 'rgba(255,255,255,0.78)'; c.fillText(k.n, x, y);
    }
  }
}

const iconCache = {};
function iconImg(name) {
  if (!name) return null;
  let im = iconCache[name];
  if (!im) {
    im = new Image();
    im.onload = () => { animating = true; };
    im.src = 'icons/' + name + '.png';
    iconCache[name] = im;
  }
  return im.complete && im.naturalWidth ? im : null;
}
const flagCache = {};
function flagImg(code) {
  let im = flagCache[code];
  if (!im) { im = new Image(); im.onload = () => { animating = true; }; im.src = 'flags/' + code + '.png'; flagCache[code] = im; }
  return im.complete && im.naturalWidth ? im : null;
}

const FRAME = { own: '#7cc7ff', ally: '#7cc7ff', enemy: '#ff5a4a', other: '#9aa4ad' };
const MARKER = 30, STEM = 14;

function draw(now) {
  if (dirty) { drawBase(); dirty = false; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(base, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  hits = [];
  const used = [];
  const overlaps = b => used.some(u => b[0] < u[2] && b[2] > u[0] && b[1] < u[3] && b[3] > u[1]);

  // Cities: a fixed-size mark at every zoom, names when there is room.
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.font = '600 12px -apple-system, "Geeza Pro", sans-serif';
  let labels = 0;
  for (const c of MAP.cities) {
    const x = sx(c.x), y = sy(c.y);
    if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
    const o = cityOwners[c.id] || c.c;
    const rel = relation(o);
    const r = c.k ? 5 : 3.2;
    ctx.beginPath(); ctx.arc(x, y, r + 1.5, 0, 6.2832); ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
    ctx.fillStyle = rel === 'own' ? '#bff08a' : rel === 'enemy' ? '#ff8a7a' : rel === 'ally' ? '#9cc8ff' : '#f4f1e6';
    ctx.fill();
    if (c.k) { ctx.beginPath(); ctx.arc(x, y, r + 3.5, 0, 6.2832); ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.2; ctx.stroke(); }
    hits.push({ kind: 'city', id: c.id, x0: x - 12, y0: y - 12, x1: x + 12, y1: y + 12 });
    const show = c.k || rel === 'own' || rel === 'enemy' || cam.s >= 2.2;
    if (!show || labels > 160) continue;
    const w = ctx.measureText(c.n).width;
    const box = [x - w / 2 - 2, y + r + 2, x + w / 2 + 2, y + r + 17];
    if (overlaps(box)) continue;
    used.push(box);
    labels++;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeText(c.n, x, y + r + 3);
    ctx.fillStyle = '#fff'; ctx.fillText(c.n, x, y + r + 3);
  }

  // Routes of own moving armies (the selected one brighter).
  let moving = false;
  ctx.setLineDash([6, 5]);
  for (const a of armies.values()) {
    if (!(a.flags & 1)) continue;
    moving = true;
    if (a.owner !== myNation) continue;
    const p = armyPos(a, now);
    ctx.beginPath(); ctx.moveTo(sx(p[0]), sy(p[1])); ctx.lineTo(sx(a.dx), sy(a.dy));
    ctx.strokeStyle = a.id === selected ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.45)';
    ctx.lineWidth = a.id === selected ? 2.5 : 1.5;
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Armies: a red dot at the exact spot, the marker above it when there is room
  // (own, selected, moving and fighting armies first).
  const list = [];
  for (const a of armies.values()) {
    const p = armyPos(a, now);
    const x = sx(p[0]), y = sy(p[1]);
    if (x < -40 || x > W + 40 || y < -60 || y > H + 20) continue;
    const rel = relation(a.owner);
    let pri = a.id === selected ? 0 : rel === 'own' ? 1 : (a.flags & 2) ? 2 : rel === 'enemy' ? 3 : (a.flags & 1) ? 4 : 5;
    list.push({ a, x, y, rel, pri });
  }
  list.sort((p, q) => p.pri - q.pri);
  const markers = [];
  for (const it of list) {
    const mx = it.x, my = it.y - STEM - MARKER / 2;
    const box = [mx - MARKER / 2 - 1, my - MARKER / 2 - 1, mx + MARKER / 2 + 1, my + MARKER / 2 + 1];
    const far = cam.s < 1.2 && it.pri > 3;
    if (far || overlaps(box)) { markers.push({ it, show: false }); continue; }
    used.push(box);
    markers.push({ it, show: true, mx, my });
  }
  for (const m of markers) {
    const { x, y } = m.it;
    ctx.beginPath(); ctx.arc(x, y, 3.2, 0, 6.2832);
    ctx.fillStyle = m.it.a.id === selected ? '#fff' : '#e8322a'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.stroke();
    hits.push({ kind: 'army', id: m.it.a.id, x0: x - 9, y0: y - 9, x1: x + 9, y1: y + 9, pri: 1 });
  }
  for (const m of markers) {
    if (!m.show) continue;
    const { a, x, y, rel } = m.it;
    const { mx, my } = m;
    ctx.beginPath(); ctx.moveTo(x, y - 3); ctx.lineTo(mx, my + MARKER / 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 2; ctx.stroke();
    const h = MARKER / 2;
    roundRect(ctx, mx - h, my - h, MARKER, MARKER, 6);
    ctx.fillStyle = (a.flags & 2) ? 'rgba(90,20,16,0.92)' : 'rgba(12,22,30,0.88)'; ctx.fill();
    ctx.lineWidth = a.id === selected ? 3 : 2;
    ctx.strokeStyle = a.id === selected ? '#ffffff' : FRAME[rel]; ctx.stroke();
    const im = iconImg(a.icon);
    if (im) ctx.drawImage(im, mx - 11, my - 12, 22, 22);
    const fl = rel !== 'own' ? flagImg(a.owner) : null;
    if (fl) ctx.drawImage(fl, mx + h - 12, my - h - 5, 14, 9);
    ctx.font = '700 10px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#000'; ctx.strokeText(String(a.n), mx, my + h - 2);
    ctx.fillStyle = '#fff'; ctx.fillText(String(a.n), mx, my + h - 2);
    hits.push({ kind: 'army', id: a.id, x0: mx - h, y0: my - h, x1: mx + h, y1: my + h, pri: 0 });
  }
  return moving;
}
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
}

function frame(now) {
  requestAnimationFrame(frame);
  if (screen !== 'game' || !MAP) return;
  if (!dirty && !animating) return;
  // Glides stop once the last message's moves are done.
  draw(now);
  let gliding = false;
  for (const a of armies.values()) { if (now - a.t0 < MOVE_MS && (a.fx !== a.tx || a.fy !== a.ty)) { gliding = true; break; } }
  animating = gliding;
}
requestAnimationFrame(frame);

// ==================== touch: pan, pinch, tap ====================
const ptrs = new Map();
let gesture = null;              // {kind: 'pan'|'pinch', ...}
let downAt = null;

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; gesture = null; }
  if (ptrs.size === 2) startPinch();
});
canvas.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  const px = p.x, py = p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (ptrs.size >= 2 && gesture && gesture.kind === 'pinch') { pinchMove(); return; }
  if (ptrs.size === 1) {
    if (!gesture && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8) gesture = { kind: 'pan' };
    if (gesture && gesture.kind === 'pan') {
      cam.x -= (e.clientX - px) / cam.s;
      cam.y -= (e.clientY - py) / cam.s;
      clampCam(); dirty = true;
    }
  }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (ptrs.size === 0) {
    if (!gesture && downAt && performance.now() - downAt.t < 600) tap(e.clientX, e.clientY);
    gesture = null; downAt = null;
  } else if (ptrs.size === 1) {
    gesture = { kind: 'pan' };   // the finger left on the glass keeps panning, never taps
  }
}
canvas.addEventListener('pointerup', endPtr);
canvas.addEventListener('pointercancel', endPtr);
function startPinch() {
  const [a, b] = [...ptrs.values()];
  gesture = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s: cam.s };
}
function pinchMove() {
  const [a, b] = [...ptrs.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const gx = wx(gesture.mx), gy = wy(gesture.my);       // world point under the old midpoint
  cam.s = gesture.s * d / Math.max(10, gesture.d);
  clampCam();
  cam.x = gx - (mx - W / 2) / cam.s;
  cam.y = gy - (my - H / 2) / cam.s;
  clampCam();
  gesture.mx = mx; gesture.my = my; gesture.d = d; gesture.s = cam.s;
  dirty = true;
}
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
function zoomAt(px, py, k) {
  const gx = wx(px), gy = wy(py);
  cam.s *= k; clampCam();
  cam.x = gx - (px - W / 2) / cam.s; cam.y = gy - (py - H / 2) / cam.s;
  clampCam(); dirty = true;
}
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault());

function tap(px, py) {
  if (moveMode && selected) {
    const tx = wx(px), ty = wy(py);
    send({ t: 'move', army: selected, x: Math.round(tx * 100) / 100, y: Math.round(ty * 100) / 100 });
    setMoveMode(false);
    return;
  }
  let best = null;
  for (const h of hits) {
    if (px < h.x0 || px > h.x1 || py < h.y0 || py > h.y1) continue;
    if (h.kind === 'army' && (!best || best.kind !== 'army' || (h.pri || 0) < (best.pri || 0))) best = h;
    else if (h.kind === 'city' && !best) best = h;
  }
  if (best && best.kind === 'army') { select(best.id); return; }
  if (best && best.kind === 'city') {
    const c = MAP.cityById[best.id];
    toast(c.n + ' — ' + countryName(cityOwners[c.id] || c.c));
  }
  select(null);
}

// ==================== selection panel and orders ====================
function select(id) {
  selected = id;
  setMoveMode(false);
  updatePanel();
  animating = true;
}
function updatePanel() {
  const a = selected && armies.get(selected);
  $('panel').classList.toggle('hidden', !a);
  if (!a) return;
  const mine = a.owner === myNation;
  const im = $('selIcon');
  const src = 'icons/' + a.icon + '.png';
  if (im.getAttribute('src') !== src) im.src = src;
  $('selTitle').textContent = (mine ? 'جيشك' : 'جيش ' + countryName(a.owner)) + ' — ' + a.n + ' وحدة';
  $('selSub').textContent = (a.flags & 2) ? 'في معركة' : (a.flags & 1) ? 'يتحرك' : 'متوقف';
  $('selCmds').classList.toggle('hidden', !mine);
}
function setMoveMode(on) {
  moveMode = on;
  $('cmdMove').classList.toggle('active', on);
  $('hint').textContent = 'اضغط على وجهة الجيش في الخريطة';
  $('hint').classList.toggle('hidden', !on);
}
$('cmdMove').onclick = () => setMoveMode(!moveMode);
$('cmdStop').onclick = () => { if (selected) send({ t: 'stop', army: selected }); };
$('selClose').onclick = () => select(null);
$('zoomIn').onclick = () => zoomAt(W / 2, H / 2, 1.6);
$('zoomOut').onclick = () => zoomAt(W / 2, H / 2, 1 / 1.6);
$('homeBtn').onclick = () => focusHome();
$('leaveBtn').onclick = () => leaveRoom(true);

function focusHome() {
  let c = MAP.cities.find(x => x.c === myNation && x.k) || MAP.cities.find(x => (cityOwners[x.id] || x.c) === myNation);
  const k = MAP.countries[myNation];
  const p = c ? [c.x, c.y] : k ? k.l : [0, 0];
  cam.x = p[0]; cam.y = p[1]; cam.s = Math.max(cam.s, 4); clampCam(); dirty = true;
}

function startGame() {
  if (screen === 'game') return;
  show('game');
  resize();
  focusHome();
  armies.clear();
  dirty = true;
}

// ==================== messages to the person ====================
let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
  if (screen !== 'game' && screen !== 'menu') console.log(text);
  if (screen === 'menu') $('serverLine').textContent = text + ' — ' + SERVER;
}
function banner(text) {
  $('banner').textContent = text;
  $('banner').classList.toggle('hidden', !text);
}

// ==================== start ====================
$('playerName').value = localStorage.getItem('wwiii_name') || '';
$('createBtn').onclick = () => send({ t: 'create', name: $('roomName').value.trim() });
$('refreshBtn').onclick = () => send({ t: 'list' });
$('resumeBtn').onclick = () => { const l = lastRoom(); if (l) enterRoom(l); };
$('pickBack').onclick = () => leaveRoom(true);
$('loadingCancel').onclick = () => leaveRoom(true);
$('nationSearch').addEventListener('input', renderNations);
setNet(false);
const hashRoom = (location.hash.match(/room=([a-z0-9]+)/) || [])[1];
if (hashRoom) {
  // A refresh inside a match: straight back to the same room and nation.
  const l = lastRoom();
  room = { id: hashRoom, name: l && l.id === hashRoom ? l.name : '', taken: {} };
  loading('العودة إلى المباراة…');
  loadMap();
}
connect();       // the menu needs no map: it is fetched when a match is entered
