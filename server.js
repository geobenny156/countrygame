/**
 * Naming Game — full server
 * - Solo & Multiplayer (quick match + private rooms)
 * - Spectator mode + anti-cheat (reject < MIN_SUBMIT_MS)
 * - Built-in topics + custom topics API
 * - Accounts (signup/login/session) + scores
 * - Name validation (profanity + live blocklist)
 * - Trivia endpoint for spectator mini-game
 * - NEW: Account management (change name/email/password, delete account+data)
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const DB = require('./db');
const leo = require('leo-profanity');

// ---- Config ----
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const MIN_SUBMIT_MS = Number(process.env.MIN_SUBMIT_MS || 150); // reject answers earlier than this per turn

try { leo.loadDictionary('en'); } catch {}

// ---------- Live-updating blocked usernames from data/blocked-names.txt ----------
const BLOCK_FILE = path.join(__dirname, 'data', 'blocked-names.txt');
function normalizeBlock(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function ensureBlockedFile() {
  try { fs.mkdirSync(path.dirname(BLOCK_FILE), { recursive: true }); } catch {}
  if (!fs.existsSync(BLOCK_FILE)) {
    const seed = [
      '# One name per line. Lines starting with # are comments.',
      'admin',
      'moderator',
      'support'
    ].join('\n');
    fs.writeFileSync(BLOCK_FILE, seed, 'utf8');
  }
}
function parseBlocked(text) {
  const out = new Set();
  (text || '').split(/\r?\n/).forEach(line => {
    const stripped = String(line).replace(/^\s*#.*$/, '').trim();
    if (!stripped) return;
    const n = normalizeBlock(stripped);
    if (n) out.add(n);
  });
  return out;
}
let BLOCKED_SET = new Set();
function loadBlockedSync() {
  try {
    const txt = fs.readFileSync(BLOCK_FILE, 'utf8');
    BLOCKED_SET = parseBlocked(txt);
    console.log(`[names] Loaded ${BLOCKED_SET.size} blocked name(s)`);
  } catch (e) {
    console.warn(`[names] Failed to load ${BLOCK_FILE}: ${e.message}`);
    BLOCKED_SET = new Set();
  }
}
function startBlockedWatcher() {
  try {
    fs.watch(BLOCK_FILE, { persistent: false }, () => setTimeout(loadBlockedSync, 120));
  } catch (e) {
    console.warn('[names] fs.watch not available:', e.message);
  }
}
ensureBlockedFile(); loadBlockedSync(); startBlockedWatcher();

// ---------- Express / IO ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '1mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*24*30, httpOnly: true, sameSite: 'lax' }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Utils ----------
function normalizeName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function shuffle(arr) { for (let i=arr.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }
function uid(prefix='id'){ let id; try { id=crypto.randomUUID().slice(0,8);} catch { id=Math.random().toString(36).slice(2,10);} return `${prefix}_${id}`; }

// Name sanitizer (server-side single source of truth)
function sanitizeDisplayName(raw, { min=2, max=24 } = {}) {
  if (raw == null) return null;
  let s = String(raw).normalize('NFKC').replace(/\s+/g, ' ').trim();
  s = s.replace(/[^\p{L}\p{N}\s'._-]/gu, '').trim();
  if (s.length > max) s = s.slice(0, max);
  if (s.length < min) return null;

  const reserved = new Set(['admin','administrator','moderator','mod','staff','system','server','host','owner','support']);
  if (reserved.has(s.toLowerCase())) return null;

  const sNorm = normalizeBlock(s);
  if (BLOCKED_SET.has(sNorm)) return null;
  if (leo.check(s)) return null; // profanity

  return s;
}

// ---------- Topic loading ----------
const TOPIC_DEFS = {
  countries:  { label: 'Countries',  kind: 'list',       file: path.join(__dirname, 'public', 'countries.json') },
  capitals:   { label: 'Capitals',   kind: 'list',       file: path.join(__dirname, 'public', 'topics', 'capitals.json') },
  currencies: { label: 'Currencies', kind: 'currencies', file: path.join(__dirname, 'public', 'topics', 'currencies.json') },
  dog_breeds: { label: 'Dog Breeds', kind: 'list',       file: path.join(__dirname, 'public', 'topics', 'dog_breeds.json') },
  pokemon_gen1:        { label: 'Pokémon (Gen 1)',      kind: 'list',      file: path.join(__dirname, 'public', 'topics', 'pokemon_gen1.json') },
  elements:            { label: 'Chemical Elements',    kind: 'elements',  file: path.join(__dirname, 'public', 'topics', 'elements.json') },
  oscars_best_picture: { label: 'Best Picture Winners', kind: 'list',      file: path.join(__dirname, 'public', 'topics', 'oscars_best_picture.json') },
  car_brands:          { label: 'Car Brands',           kind: 'list',      file: path.join(__dirname, 'public', 'topics', 'car_brands.json') }
};
const BUILTIN_TOPICS_LIST = Object.entries(TOPIC_DEFS).map(([key, def]) => ({ key, label: def.label }));

function loadJSON(file) {
  try {
    let txt = fs.readFileSync(file, 'utf8');
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
    return JSON.parse(txt);
  } catch { return null; }
}
function buildListValidator(names, extraAliases = new Map()) {
  const CANON = new Map();
  for (const name of names || []) CANON.set(normalizeName(name), name);
  const ALIASES = new Map(extraAliases);
  return {
    toCanonical(input) {
      const n = normalizeName(input);
      if (ALIASES.has(n)) return ALIASES.get(n);
      if (CANON.has(n)) return CANON.get(n);
      return null;
    },
    canonicalList: Array.from(CANON.values())
  };
}
function buildCurrenciesValidator(arr) {
  const CANON = new Map(); const names = [];
  for (const item of arr || []) {
    const name = item.name; if (!name) continue;
    names.push(name);
    CANON.set(normalizeName(name), name);
    if (item.code) CANON.set(normalizeName(item.code), name);
    for (const alias of (item.aliases || [])) CANON.set(normalizeName(alias), name);
  }
  return { toCanonical(input) { return CANON.get(normalizeName(input)) || null; }, canonicalList: names };
}
function buildElementsValidator(arr) {
  const CANON = new Map(); const names = [];
  for (const item of arr || []) {
    if (!item || !item.name) continue;
    const name = item.name;
    names.push(name);
    CANON.set(normalizeName(name), name);
    if (item.symbol) CANON.set(normalizeName(item.symbol), name);
    for (const alias of (item.aliases || [])) CANON.set(normalizeName(alias), name);
  }
  return { toCanonical(input) { return CANON.get(normalizeName(input)) || null; }, canonicalList: names };
}

// Helpful aliases
const COUNTRY_ALIASES = new Map(Object.entries({
  'usa':'United States','us':'United States','united states of america':'United States',
  'uk':'United Kingdom','uae':'United Arab Emirates','ivory coast':'Côte d’Ivoire',
  'swaziland':'Eswatini','czech republic':'Czechia','burma':'Myanmar',
  'vatican':'Vatican City','vatican city':'Vatican City','saudi':'Saudi Arabia',
  'drc':'Democratic Republic of the Congo','congo kinshasa':'Democratic Republic of the Congo',
  'republic of the congo':'Republic of the Congo','congo brazzaville':'Republic of the Congo',
  'south korea':'South Korea','north korea':'North Korea','palestine':'State of Palestine','turkiye':'Turkey'
}));
const CAPITAL_ALIASES = new Map(Object.entries({
  'washington dc':'Washington, D.C.','washington d c':'Washington, D.C.',
  'ulan bator':'Ulaanbaatar','kiev':'Kyiv','pnom penh':'Phnom Penh'
}));
const POKEMON_ALIASES = new Map(Object.entries({
  'mr mime':'Mr. Mime','mr. mime':'Mr. Mime',
  'farfetchd':'Farfetch’d','farfetch d':'Farfetch’d','farfetch’d':'Farfetch’d',
  'nidoran m':'Nidoran♂','nidoran male':'Nidoran♂',
  'nidoran f':'Nidoran♀','nidoran female':'Nidoran♀'
}));
const CAR_BRAND_ALIASES = new Map(Object.entries({
  'vw':'Volkswagen','v w':'Volkswagen',
  'mercedes':'Mercedes-Benz','mercedes benz':'Mercedes-Benz','benz':'Mercedes-Benz','merc':'Mercedes-Benz','mb':'Mercedes-Benz',
  'chevy':'Chevrolet','skoda':'Škoda','gwm':'Great Wall Motors',
  'landrover':'Land Rover','range rover':'Land Rover',
  'rr':'Rolls-Royce','rolls':'Rolls-Royce'
}));

function loadTopic(topicKey) {
  if (TOPIC_DEFS[topicKey]) {
    const def = TOPIC_DEFS[topicKey];
    const data = loadJSON(def.file);
    if (def.kind === 'currencies') return { label: def.label, key: topicKey, ...buildCurrenciesValidator(Array.isArray(data) ? data : []) };
    if (def.kind === 'elements')   return { label: def.label, key: topicKey, ...buildElementsValidator(Array.isArray(data) ? data : []) };
    if (def.kind === 'list') {
      const aliases =
        topicKey === 'countries' ? COUNTRY_ALIASES :
        topicKey === 'capitals'  ? CAPITAL_ALIASES  :
        topicKey === 'pokemon_gen1' ? POKEMON_ALIASES :
        topicKey === 'car_brands' ? CAR_BRAND_ALIASES :
        new Map();
      return { label: def.label, key: topicKey, ...buildListValidator(Array.isArray(data) ? data : [], aliases) };
    }
  }
  const c = DB.getCustomTopicByKey(topicKey);
  if (c) return { label: c.label, key: c.key, ...buildListValidator(c.items, new Map()) };
  const def = TOPIC_DEFS.countries;
  const data = loadJSON(def.file) || [];
  return { label: def.label, key: 'countries', ...buildListValidator(data, COUNTRY_ALIASES) };
}

// Convenience loaders for trivia mappings
function loadCurrenciesData() {
  const arr = loadJSON(TOPIC_DEFS.currencies.file) || [];
  return arr.filter(x => x && x.name && x.code).map(x => ({ name: x.name, code: String(x.code).toUpperCase() }));
}
function loadElementsData() {
  const arr = loadJSON(TOPIC_DEFS.elements.file) || [];
  return arr.filter(x => x && x.name && x.symbol).map(x => ({ name: x.name, symbol: String(x.symbol) }));
}

// ---------- Room state ----------
/**
rooms[roomCode] = {
  mode: 'solo' | 'pvp',
  hostId: string | null,
  players: [{ id, name, socketId, alive, joinedAt, score }],
  phase: 'lobby' | 'playing' | 'ended',
  used: Set<string>,
  order: string[],
  idx: number,
  perTurn: number,
  timers: { interval?, timeout?, remaining, turnStartAt? },
  round: { pending: Set<string>, answered: number } | null,
  topicKey: string,
  topic: { label, key, toCanonical(), canonicalList }
}
*/
const rooms = Object.create(null);

function broadcastRoom(roomCode) {
  const room = rooms[roomCode]; if (!room) return;
  io.to(roomCode).emit('room:update', {
    roomCode,
    hostId: room.hostId || null,
    phase: room.phase,
    perTurn: room.perTurn,
    topicKey: room.topicKey || 'countries',
    topicLabel: room.topic?.label || 'Countries',
    mode: room.mode || 'pvp',
    players: room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, score: p.score })),
    currentPlayerId: room.phase === 'playing' ? room.order[room.idx] : null,
    used: Array.from(room.used)
  });
}
function clearTimers(room){ if(room.timers.interval)clearInterval(room.timers.interval); if(room.timers.timeout)clearTimeout(room.timers.timeout); room.timers.interval=room.timers.timeout=undefined; }
function nextAliveIndex(room, fromIdx){ const n=room.order.length; for(let s=1;s<=n;s++){const i=(fromIdx+s)%n; const pid=room.order[i]; const p=room.players.find(pp=>pp.id===pid); if(p&&p.alive) return i;} return -1; }
function aliveCount(room){ return room.players.filter(p=>p.alive).length; }
function aliveIdsInOrder(room){ return room.order.filter(id => { const p=room.players.find(pp=>pp.id===id); return p&&p.alive; }); }
function makeRoomCode(){ const letters='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code=''; for(let i=0;i<6;i++) code+=letters[Math.floor(Math.random() * letters.length)]; return rooms[code]?makeRoomCode():code; }

function endGame(roomCode){
  const room = rooms[roomCode]; if(!room) return;
  room.phase='ended';
  const winner = room.players.find(p=>p.alive);
  io.to(roomCode).emit('game:over', {
    winnerId: winner ? winner.id : null,
    players: room.players.map(p => ({ id:p.id, name:p.name, score:p.score, alive:p.alive }))
  });
  broadcastRoom(roomCode);
}
function declareDraw(roomCode){
  const room = rooms[roomCode]; if(!room) return;
  room.phase='ended';
  io.to(roomCode).emit('game:draw', {
    players: room.players.map(p => ({ id:p.id, name:p.name, score:p.score, alive:p.alive }))
  });
  broadcastRoom(roomCode);
}
function soloOver(roomCode, reason){
  const room = rooms[roomCode]; if(!room) return;
  room.phase='ended';
  io.to(roomCode).emit('solo:over', {
    reason,
    topicLabel: room.topic?.label || 'Topic',
    usedCount: room.used.size,
    total: room.topic?.canonicalList?.length ?? null,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
  });
  broadcastRoom(roomCode);
}

function beginRound(room, startIdx){
  const aliveIds = aliveIdsInOrder(room);
  room.round = { pending: new Set(aliveIds), answered: 0 };
  if (typeof startIdx === 'number') room.idx = startIdx;
  let pid = room.order[room.idx];
  let p = room.players.find(pp => pp.id === pid);
  if (!p || !p.alive) {
    const ni = nextAliveIndex(room, room.idx);
    if (ni !== -1) room.idx = ni;
  }
}
function handleRoundEnd(roomCode){
  const room = rooms[roomCode]; if(!room || room.phase!=='playing' || !room.round) return;
  if (room.round.answered === 0) { declareDraw(roomCode); return; }
  if (aliveCount(room) <= 1) { endGame(roomCode); return; }
  const nextIdx = nextAliveIndex(room, room.idx);
  if (nextIdx === -1) { endGame(roomCode); return; }
  beginRound(room, nextIdx);
  startPvpTurn(roomCode);
}
function afterTurn(roomCode, lastPlayerId){
  const room = rooms[roomCode]; if(!room || room.phase!=='playing' || !room.round) return;
  if (lastPlayerId) room.round.pending.delete(lastPlayerId);
  if (room.round.pending.size === 0) { handleRoundEnd(roomCode); return; }
  const ni = nextAliveIndex(room, room.idx);
  if (ni === -1) { handleRoundEnd(roomCode); } else { room.idx = ni; startPvpTurn(roomCode); }
}

// ---- Turn/timer helpers (set turnStartAt for anti-cheat) ----
function startPvpTurn(roomCode){
  const room = rooms[roomCode]; if(!room || room.phase!=='playing' || room.mode==='solo') return;
  clearTimers(room);

  let currentId = room.order[room.idx];
  let current = room.players.find(p => p.id === currentId);
  if (!current || !current.alive) {
    const ni = nextAliveIndex(room, room.idx);
    if (ni === -1) { handleRoundEnd(roomCode); return; }
    room.idx = ni; currentId = room.order[room.idx]; current = room.players.find(p=>p.id===currentId);
  }

  room.timers.remaining = room.perTurn;
  room.timers.turnStartAt = Date.now(); // anti-cheat timestamp
  io.to(roomCode).emit('turn:start', { currentPlayerId: currentId, remaining: room.timers.remaining });

  room.timers.interval = setInterval(() => {
    room.timers.remaining -= 1;
    io.to(roomCode).emit('turn:tick', { remaining: Math.max(0, room.timers.remaining) });
  }, 1000);

  room.timers.timeout = setTimeout(() => {
    io.to(roomCode).emit('turn:tick', { remaining: 0 });
    clearTimers(room);
    const cur = room.players.find(p=>p.id===currentId);
    if (cur) cur.alive = false; // timeout eliminates
    io.to(roomCode).emit('turn:timeout', { playerId: currentId });
    broadcastRoom(roomCode);
    afterTurn(roomCode, currentId);
  }, room.perTurn * 1000);
}

function startSoloTurn(roomCode){
  const room = rooms[roomCode]; if(!room || room.phase!=='playing' || room.mode!=='solo') return;
  clearTimers(room);

  const currentId = room.order[room.idx];
  room.timers.remaining = room.perTurn;
  room.timers.turnStartAt = Date.now(); // anti-cheat timestamp
  io.to(roomCode).emit('turn:start', { currentPlayerId: currentId, remaining: room.timers.remaining });

  room.timers.interval = setInterval(() => {
    room.timers.remaining -= 1;
    io.to(roomCode).emit('turn:tick', { remaining: Math.max(0, room.timers.remaining) });
  }, 1000);

  room.timers.timeout = setTimeout(() => {
    room.timers.remaining = 0;
    io.to(roomCode).emit('turn:tick', { remaining: 0 });
    clearTimers(room);
    io.to(roomCode).emit('turn:timeout', { playerId: currentId });
    soloOver(roomCode, 'timeout');
  }, room.perTurn * 1000);
}

// ---------- Matchmaking (Quick Match) ----------
const queues = new Map();
const queueKey = (size, perTurn, topicKey) => `${size}|${perTurn}|${topicKey}`;
function tryFormMatch(key){
  const arr = queues.get(key); if(!arr) return;
  const [sizeStr, perStr, topicKey] = key.split('|');
  const size = Number(sizeStr), perTurn = Number(perStr);
  while (arr.length >= size) {
    shuffle(arr);
    const batch = arr.splice(0, size);
    const roomCode = makeRoomCode();
    const now = Date.now();
    const players = batch.map(w => ({ id:w.socketId, name:w.name.trim()||'Player', socketId:w.socketId, alive:true, joinedAt:now, score:0 }));
    const seen = new Set();
    for (const p of players) {
      let base=p.name, cand=base, n=2;
      while (seen.has(cand.toLowerCase())) cand = `${base} ${n++}`;
      seen.add(cand.toLowerCase()); p.name = cand;
    }
    const topic = loadTopic(topicKey || 'countries');
    rooms[roomCode] = {
      mode: 'pvp',
      hostId: null,
      players,
      phase: 'playing',
      used: new Set(),
      order: shuffle(players.map(p => p.id)),
      idx: 0,
      perTurn,
      timers: { remaining: perTurn, turnStartAt: Date.now() },
      round: null,
      topicKey: topic.key,
      topic
    };
    for (const w of batch) {
      const s = io.sockets.sockets.get(w.socketId); if (!s) continue;
      s.join(roomCode);
      s.data.roomCode = roomCode;
      s.data.matchKey = undefined;
      s.data.name = players.find(p=>p.id===w.socketId)?.name || 'Player';
      s.emit('match:found', { roomCode });
    }
    broadcastRoom(roomCode);
    beginRound(rooms[roomCode], 0);
    startPvpTurn(roomCode);
  }
}

// ---------- Leave helper ----------
function safeLeaveRoom(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode || !rooms[roomCode]) {
    socket.data.roomCode = undefined;
    io.to(socket.id).emit('room:left', { ok: true });
    return;
  }
  const room = rooms[roomCode];
  const idx = room.players.findIndex(p => p.id === socket.id);
  if (idx < 0) {
    socket.leave(roomCode);
    socket.data.roomCode = undefined;
    io.to(socket.id).emit('room:left', { ok: true });
    return;
  }
  const wasHost = room.hostId === socket.id;
  const orderIdx = room.order.indexOf(socket.id);
  const wasCurrent = (room.phase === 'playing' && orderIdx === room.idx);
  if (wasCurrent) clearTimers(room);

  room.players[idx].alive = false;
  if (orderIdx >= 0) room.order.splice(orderIdx, 1);
  room.players.splice(idx, 1);
  socket.leave(roomCode);
  socket.data.roomCode = undefined;

  if (wasHost && room.players.length > 0) room.hostId = room.players[0].id;
  if (room.players.length === 0) { clearTimers(room); delete rooms[roomCode]; io.to(socket.id).emit('room:left', { ok: true }); return; }

  if (room.phase === 'playing') {
    if (wasCurrent) {
      if (room.round && room.round.pending) room.round.pending.delete(socket.id);
      if (room.round && room.round.pending.size === 0) { handleRoundEnd(roomCode); }
      else { room.idx = Math.max(0, Math.min(orderIdx, room.order.length - 1)); startPvpTurn(roomCode); }
    } else {
      if (room.round && room.round.pending) room.round.pending.delete(socket.id);
      if (orderIdx !== -1 && orderIdx < room.idx) room.idx = Math.max(0, room.idx - 1);
      if (room.round && room.round.pending.size === 0) handleRoundEnd(roomCode);
    }
    if (aliveCount(room) <= 0) declareDraw(roomCode);
  }
  broadcastRoom(roomCode);
  io.to(socket.id).emit('room:left', { ok: true });
}

// ---------- Sockets ----------
io.on('connection', (socket) => {
  // SOLO
  socket.on('solo:start', ({ perTurn, topicKey, name }) => {
    if (socket.data.roomCode) safeLeaveRoom(socket);

    const pname = sanitizeDisplayName(name);
    if (!pname) { socket.emit('name:invalid', { reason: 'bad_name' }); return; }

    const tkey = TOPIC_DEFS[topicKey] ? topicKey : (DB.getCustomTopicByKey(topicKey) ? topicKey : 'countries');
    const topic = loadTopic(tkey);

    const roomCode = makeRoomCode();
    const secs = clamp(Number(perTurn) || 10, 5, 120);

    rooms[roomCode] = {
      mode: 'solo',
      hostId: socket.id,
      players: [{ id: socket.id, name: pname, socketId: socket.id, alive: true, joinedAt: Date.now(), score: 0 }],
      phase: 'playing',
      used: new Set(),
      order: [socket.id],
      idx: 0,
      perTurn: secs,
      timers: { remaining: secs, turnStartAt: Date.now() },
      round: null,
      topicKey: topic.key,
      topic
    };

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.name = pname;

    broadcastRoom(roomCode);
    startSoloTurn(roomCode);
  });

  // QUICK MATCH
  socket.on('match:queue', ({ opponents, perTurn, topicKey, name }) => {
    if (socket.data.roomCode) safeLeaveRoom(socket);

    const pname = sanitizeDisplayName(name);
    if (!pname) { socket.emit('name:invalid', { reason: 'bad_name' }); return; }

    const size = clamp((Number(opponents) || 1) + 1, 2, 8);
    const secs = clamp(Number(perTurn) || 15, 5, 120);
    const tkey = TOPIC_DEFS[topicKey] ? topicKey : (DB.getCustomTopicByKey(topicKey) ? topicKey : 'countries');
    const key = queueKey(size, secs, tkey);

    let arr = queues.get(key); if (!arr) { arr = []; queues.set(key, arr); }
    if (arr.findIndex(w => w.socketId === socket.id) === -1) {
      arr.push({ socketId: socket.id, name: pname });
    }
    socket.data.matchKey = key;

    socket.emit('match:searching', { size, perTurn: secs, topicLabel: loadTopic(tkey).label });
    tryFormMatch(key);
  });

  socket.on('match:cancel', () => {
    if (!socket.data.matchKey) return;
    const arr = queues.get(socket.data.matchKey);
    if (arr) {
      const i = arr.findIndex(w => w.socketId === socket.id);
      if (i >= 0) arr.splice(i, 1);
    }
    socket.data.matchKey = undefined;
    socket.emit('match:cancelled', {});
  });

  // PRIVATE ROOM create/join
  socket.on('room:create', ({ name, topicKey }) => {
    if (socket.data.roomCode) safeLeaveRoom(socket);

    const pname = sanitizeDisplayName(name);
    if (!pname) { socket.emit('name:invalid', { reason: 'bad_name' }); return; }

    const tkey = TOPIC_DEFS[topicKey] ? topicKey : (DB.getCustomTopicByKey(topicKey) ? topicKey : 'countries');
    const topic = loadTopic(tkey);

    const roomCode = makeRoomCode();

    rooms[roomCode] = {
      mode: 'pvp',
      hostId: socket.id,
      players: [{ id: socket.id, name: pname, socketId: socket.id, alive: true, joinedAt: Date.now(), score: 0 }],
      phase: 'lobby',
      used: new Set(),
      order: [socket.id],
      idx: 0,
      perTurn: 15,
      timers: { remaining: 15 },
      round: null,
      topicKey: topic.key,
      topic
    };

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.name = pname;

    socket.emit('room:created', { roomCode });
    broadcastRoom(roomCode);
  });

  socket.on('room:join', ({ roomCode, name }) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const room = rooms[roomCode];
    if (!room) return socket.emit('error:msg', { message: 'Room not found.' });
    if (room.phase !== 'lobby') return socket.emit('error:msg', { message: 'Game already started.' });

    const pname = sanitizeDisplayName(name);
    if (!pname) { socket.emit('name:invalid', { reason: 'bad_name' }); return; }

    let candidate = pname, suffix = 2;
    const names = new Set(room.players.map(p => p.name.toLowerCase()));
    while (names.has(candidate.toLowerCase())) candidate = `${pname} ${suffix++}`;

    room.players.push({ id: socket.id, name: candidate, socketId: socket.id, alive: true, joinedAt: Date.now(), score: 0 });
    room.order.push(socket.id);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.name = candidate;
    broadcastRoom(roomCode);
  });

  // Game start / reset / leave
  socket.on('game:start', ({ roomCode, perTurn, topicKey }) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const room = rooms[roomCode]; if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.players.length < 2) return socket.emit('error:msg', { message: 'Need at least 2 players.' });

    room.mode = 'pvp';
    room.perTurn = clamp(Number(perTurn) || room.perTurn || 15, 5, 120);
    room.used = new Set();
    room.phase = 'playing';
    for (const p of room.players) { p.alive = true; p.score = 0; }

    room.order = shuffle(room.players.map(p => p.id));
    room.idx = 0;

    const t = loadTopic(topicKey);
    room.topicKey = t.key;
    room.topic = t;

    broadcastRoom(roomCode);
    beginRound(room, 0);
    startPvpTurn(roomCode);
  });

  socket.on('game:reset', ({ roomCode }) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const room = rooms[roomCode]; if (!room) return;
    const isPrivateRoom = !!room.hostId;
    const isEnded = room.phase === 'ended';
    if (!isPrivateRoom) return;
    if (!isEnded && socket.id !== room.hostId) return;

    clearTimers(room);
    room.phase = 'lobby';
    room.used = new Set();
    room.round = null;
    for (const p of room.players) { p.alive = true; p.score = 0; }
    room.order = room.players.map(p => p.id);
    room.idx = 0;
    broadcastRoom(roomCode);
  });

  socket.on('room:leave', () => { safeLeaveRoom(socket); });

  // Answers — includes anti-cheat early-submission guard
  socket.on('answer:submit', ({ roomCode, answer }) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const room = rooms[roomCode]; if (!room || room.phase !== 'playing') return;
    const currentId = room.order[room.idx];
    if (socket.id !== currentId) return socket.emit('error:msg', { message: 'Not your turn.' });

    const now = Date.now();
    const t0 = Number(room.timers.turnStartAt || 0);
    const elapsed = now - t0;
    if (t0 && elapsed < MIN_SUBMIT_MS) {
      return socket.emit('answer:rejected', { reason: 'toosoon', min: MIN_SUBMIT_MS, elapsed });
    }

    const canonical = room.topic?.toCanonical(answer || '');
    if (!canonical) return socket.emit('answer:rejected', { reason: 'invalid' });
    if (room.used.has(canonical)) return socket.emit('answer:rejected', { reason: 'repeated', country: canonical });

    room.used.add(canonical);
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.score += 1;

    clearTimers(room);
    io.to(roomCode).emit('answer:accepted', { value: canonical });
    broadcastRoom(roomCode);

    if (room.mode === 'solo') {
      const total = room.topic?.canonicalList?.length ?? Infinity;
      if (room.used.size >= total) {
        soloOver(roomCode, 'completed');
      } else {
        startSoloTurn(roomCode);
      }
    } else {
      if (room.round) room.round.answered += 1;
      afterTurn(roomCode, currentId);
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (socket.data.matchKey) {
      const arr = queues.get(socket.data.matchKey);
      if (arr) {
        const i = arr.findIndex(w => w.socketId === socket.id);
        if (i >= 0) arr.splice(i, 1);
      }
    }
    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx < 0) return;

    const wasHost = room.hostId === socket.id;
    const orderIdx = room.order.indexOf(socket.id);
    const wasCurrent = (room.phase === 'playing' && orderIdx === room.idx);
    if (wasCurrent) clearTimers(room);

    room.players[idx].alive = false;
    if (orderIdx >= 0) room.order.splice(orderIdx, 1);
    room.players.splice(idx, 1);

    if (wasHost && room.players.length > 0) room.hostId = room.players[0].id;
    if (room.players.length === 0) { clearTimers(room); delete rooms[roomCode]; return; }

    if (room.phase === 'playing') {
      if (wasCurrent) {
        if (room.round && room.round.pending) room.round.pending.delete(socket.id);
        if (room.round && room.round.pending.size === 0) { handleRoundEnd(roomCode); }
        else { room.idx = Math.max(0, Math.min(orderIdx, room.order.length - 1)); startPvpTurn(roomCode); }
      } else {
        if (room.round && room.round.pending) room.round.pending.delete(socket.id);
        if (orderIdx !== -1 && orderIdx < room.idx) room.idx = Math.max(0, room.idx - 1);
        if (room.round && room.round.pending.size === 0) handleRoundEnd(roomCode);
      }
      if (aliveCount(room) <= 0) declareDraw(roomCode);
    }
    broadcastRoom(roomCode);
  });
});

// ---------- Auth & Scores & Topics APIs ----------
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, displayName } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  const p = String(password || '');
  const rawName = String(displayName || '').trim();
  const name2 = sanitizeDisplayName(rawName);
  if (!e || !p || !rawName) return res.status(400).json({ ok: false, error: 'Missing fields.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ ok: false, error: 'Invalid email.' });
  if (p.length < 6) return res.status(400).json({ ok: false, error: 'Password too short (min 6).' });
  if (!name2) return res.status(400).json({ ok: false, error: 'Display name not allowed. Pick another.' });
  if (DB.findUserByEmail(e)) return res.status(409).json({ ok: false, error: 'Email already in use.' });

  const hash = await bcrypt.hash(p, 10);
  const user = { id: uid('u'), email: e, displayName: name2, passHash: hash, createdAt: new Date().toISOString() };
  DB.createUser(user);
  req.session.user = { id: user.id, email: user.email, displayName: user.displayName };
  res.json({ ok: true, user: req.session.user });
});
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  const p = String(password || '');
  const user = DB.findUserByEmail(e);
  if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials.' });
  const ok = await bcrypt.compare(p, user.passHash);
  if (!ok) return res.status(401).json({ ok: false, error: 'Invalid credentials.' });
  req.session.user = { id: user.id, email: user.email, displayName: user.displayName };
  res.json({ ok: true, user: req.session.user });
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/auth/me', (req, res) => { res.json({ ok: true, user: req.session.user || null }); });

app.post('/api/scores/record', (req, res) => {
  const me = req.session.user;
  if (!me) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  const { mode, topicKey, score, outcome } = req.body || {};
  const m = mode === 'solo' ? 'solo' : 'pvp';
  const isBuiltin = !!TOPIC_DEFS[topicKey];
  const isCustom = !!DB.getCustomTopicByKey(topicKey);
  if (!isBuiltin && !isCustom) return res.status(400).json({ ok:false, error:'Invalid topic.' });

  const s = Number(score) || 0;
  const o = String(outcome || '').toLowerCase();
  const validOutcome = (m === 'solo') ? (o === 'completed' || o === 'timeout')
                                      : (o === 'win' || o === 'loss' || o === 'draw');
  if (!validOutcome) return res.status(400).json({ ok: false, error: 'Invalid outcome.' });

  const rec = { id: uid('s'), userId: me.id, mode: m, topicKey, score: s, outcome: o, createdAt: new Date().toISOString() };
  DB.addScore(rec);
  res.json({ ok: true, score: rec });
});
app.get('/api/scores/me', (req, res) => {
  const me = req.session.user;
  if (!me) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  res.json({ ok: true, scores: DB.scoresByUser(me.id, 100) });
});
app.get('/api/leaderboard', (req, res) => {
  const topicKey = String(req.query.topicKey || 'countries');
  const mode = String(req.query.mode || 'pvp');
  const limit = clamp(Number(req.query.limit) || 10, 1, 50);
  const isBuiltin = !!TOPIC_DEFS[topicKey];
  const isCustom = !!DB.getCustomTopicByKey(topicKey);
  if (!isBuiltin && !isCustom) return res.status(400).json({ ok: false, error: 'Invalid topic.' });
  if (!['pvp','solo'].includes(mode)) return res.status(400).json({ ok: false, error: 'Invalid mode.' });
  res.json({ ok: true, topicKey, mode, scores: DB.topByTopic(topicKey, mode, limit) });
});

app.get('/api/topics/all', (_req, res) => {
  res.json({ ok: true, builtin: BUILTIN_TOPICS_LIST, custom: DB.listCustomTopics() });
});
app.get('/api/topics/custom', (_req, res) => {
  res.json({ ok: true, topics: DB.listCustomTopics() });
});
app.post('/api/topics/custom', (req, res) => {
  const { label, items, itemsText } = req.body || {};
  const lab = String(label || '').trim();
  if (lab.length < 3 || lab.length > 40) return res.status(400).json({ ok:false, error:'Topic name must be 3–40 characters.' });

  let raw = [];
  if (Array.isArray(items)) raw = items.map(x => String(x || ''));
  else if (typeof itemsText === 'string') raw = itemsText.split(/\r?\n/);
  else if (typeof req.body.items === 'string') raw = String(req.body.items).split(/\r?\n/);
  else return res.status(400).json({ ok:false, error:'Provide answers (one per line).' });

  const seen = new Set(); const arr = [];
  for (let s of raw) {
    s = String(s || '').trim(); if (!s) continue;
    if (s.length > 80) s = s.slice(0, 80);
    const n = normalizeName(s); if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n); arr.push(s);
  }
  if (arr.length < 3) return res.status(400).json({ ok:false, error:'Add at least 3 acceptable answers.' });
  if (arr.length > 1000) arr.length = 1000;

  const topic = DB.createCustomTopic({ label: lab, items: arr, createdBy: (req.session.user && req.session.user.id) || null });
  res.json({ ok: true, topic: { key: topic.key, label: topic.label, count: topic.count, createdAt: topic.createdAt } });
});

// Name validation API
app.post('/api/name/validate', (req, res) => {
  const raw = (req.body && req.body.name) || '';
  if (!raw || !raw.trim()) return res.json({ ok: true, valid: false, error: 'Please enter your name.' });
  const clean = sanitizeDisplayName(raw);
  if (!clean) return res.json({ ok: true, valid: false, error: 'That name is not allowed. Try another.' });
  return res.json({ ok: true, valid: true });
});

// ---------- Trivia generator API ----------
app.get('/api/trivia/generate', (req, res) => {
  const topicKey = String(req.query.topicKey || 'countries');
  const N = clamp(Number(req.query.n) || 120, 10, 300);

  // Load target topic
  const topic = loadTopic(topicKey);
  const label = topic.label || 'Topic';
  const list  = Array.isArray(topic.canonicalList) ? topic.canonicalList.slice() : [];

  // Build decoy pool from other built-in topics
  const decoyPool = [];
  for (const [k] of Object.entries(TOPIC_DEFS)) {
    if (k === topicKey) continue;
    const t = loadTopic(k);
    if (Array.isArray(t.canonicalList)) decoyPool.push(...t.canonicalList);
  }
  if (decoyPool.length < 50) decoyPool.push('Atlantis','Springfield','Gotham','Wakanda','El Dorado','Ruritania','Metropolis');

  function sample(arr, n) { if (!arr.length) return []; const a = arr.slice(); shuffle(a); return a.slice(0, Math.min(n, a.length)); }
  function sampleOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  const questions = [];

  // Specialized typed questions
  if (topicKey === 'currencies') {
    const rows = loadCurrenciesData(); shuffle(rows);
    for (const r of rows.slice(0, Math.ceil(N * 0.25))) {
      questions.push({ id: uid('q'), type: 'text', prompt: `What is the 3-letter currency code for "${r.name}"?`, answer: r.code, compare: 'case-insensitive' });
    }
  } else if (topicKey === 'elements') {
    const rows = loadElementsData(); shuffle(rows);
    for (const r of rows.slice(0, Math.ceil(N * 0.25))) {
      questions.push({ id: uid('q'), type: 'text', prompt: `What is the chemical symbol for "${r.name}"?`, answer: r.symbol, compare: 'case-insensitive' });
    }
  }

  // Multiple choice
  const mcCount = Math.ceil(N * 0.5);
  const mcCorrects = sample(list, mcCount);
  for (const correct of mcCorrects) {
    const opts = [correct];
    let attempts = 0;
    while (opts.length < 4 && attempts < 50) {
      const d = sampleOne(decoyPool);
      if (d && !list.includes(d) && !opts.includes(d)) opts.push(d);
      attempts++;
    }
    shuffle(opts);
    questions.push({ id: uid('q'), type: 'mc', prompt: `Which of these is in the list of ${label}?`, options: opts, correctIndex: opts.indexOf(correct) });
  }

  // True/False
  const tfCount = Math.max(0, N - questions.length);
  const tfTrue = sample(list, Math.ceil(tfCount / 2)).map(v => ({ id: uid('q'), type: 'tf', prompt: `Is “${v}” in the list of ${label}?`, answerTrue: true }));
  const tfFalse = sample(decoyPool.filter(d => !list.includes(d)), Math.floor(tfCount / 2)).map(v => ({ id: uid('q'), type: 'tf', prompt: `Is “${v}” in the list of ${label}?`, answerTrue: false }));
  questions.push(...tfTrue, ...tfFalse);

  shuffle(questions);
  res.json({ ok: true, topicKey, label, count: questions.length, questions });
});

// ----------- Account management routes (require session) -----------
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  next();
}

// Change display name
app.post('/api/account/name', requireAuth, (req, res) => {
  const me = req.session.user;
  const raw = (req.body && req.body.displayName) || '';
  const name = sanitizeDisplayName(raw);
  if (!name) return res.status(400).json({ ok:false, error:'Display name not allowed. Try another.' });

  const ok = DB.updateUserDisplayName(me.id, name);
  if (!ok) return res.status(500).json({ ok:false, error:'Could not update name.' });

  req.session.user.displayName = name;
  res.json({ ok:true, user: req.session.user });
});

// Change email (requires current password)
app.post('/api/account/email', requireAuth, async (req, res) => {
  const me = req.session.user;
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');

  if (!email || !password) return res.status(400).json({ ok:false, error:'Missing email or password.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok:false, error:'Invalid email.' });

  const user = DB.findUserById(me.id);
  if (!user) return res.status(401).json({ ok:false, error:'Session invalid.' });

  const valid = await bcrypt.compare(password, user.passHash);
  if (!valid) return res.status(401).json({ ok:false, error:'Incorrect password.' });

  const other = DB.findUserByEmail(email);
  if (other && other.id !== me.id) return res.status(409).json({ ok:false, error:'Email already in use.' });

  const ok = DB.updateUserEmail(me.id, email);
  if (!ok) return res.status(500).json({ ok:false, error:'Could not update email.' });

  req.session.user.email = email;
  res.json({ ok:true, user: req.session.user });
});

// Change password (requires current password)
app.post('/api/account/password', requireAuth, async (req, res) => {
  const me = req.session.user;
  const currentPassword = String((req.body && req.body.currentPassword) || '');
  const newPassword = String((req.body && req.body.newPassword) || '');

  if (!currentPassword || !newPassword) return res.status(400).json({ ok:false, error:'Missing fields.' });
  if (newPassword.length < 6) return res.status(400).json({ ok:false, error:'Password too short (min 6).' });

  const user = DB.findUserById(me.id);
  if (!user) return res.status(401).json({ ok:false, error:'Session invalid.' });

  const okPw = await bcrypt.compare(currentPassword, user.passHash);
  if (!okPw) return res.status(401).json({ ok:false, error:'Incorrect password.' });

  const hash = await bcrypt.hash(newPassword, 10);
  const ok = DB.updateUserPassword(me.id, hash);
  if (!ok) return res.status(500).json({ ok:false, error:'Could not update password.' });

  res.json({ ok:true });
});

// Delete account + data (scores + custom topics)
app.delete('/api/account', requireAuth, async (req, res) => {
  const me = req.session.user;
  const confirm = String((req.body && req.body.confirm) || '');
  const password = String((req.body && req.body.password) || '');
  if (confirm !== 'DELETE') return res.status(400).json({ ok:false, error:'Type DELETE to confirm.' });

  const user = DB.findUserById(me.id);
  if (!user) return res.status(401).json({ ok:false, error:'Session invalid.' });

  const okPw = await bcrypt.compare(password, user.passHash);
  if (!okPw) return res.status(401).json({ ok:false, error:'Incorrect password.' });

  const result = DB.deleteUserAndData(me.id);
  req.session.destroy(() => res.json({ ok:true, removed: result }));
});

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`Naming Game server http://localhost:${PORT} (MIN_SUBMIT_MS=${MIN_SUBMIT_MS})`);
});
