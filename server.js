/**
 * Naming Game — Multi-page with Solo, Quick Match, and Private Rooms
 * Flow: Home -> Topics -> Rules -> Play
 * - Solo: timer resets on correct answers
 * - Quick Match (PvP): matchmaking by opponents/perTurn/topic
 * - Private Room (PvP): host creates a room code; friends join; host starts game
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Utils ----------
function normalizeName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

// ---------- Topic loading ----------
const TOPIC_DEFS = {
  countries:  { label: 'Countries',  kind: 'list',       file: path.join(__dirname, 'public', 'countries.json') },
  capitals:   { label: 'Capitals',   kind: 'list',       file: path.join(__dirname, 'public', 'topics', 'capitals.json') },
  currencies: { label: 'Currencies', kind: 'currencies', file: path.join(__dirname, 'public', 'topics', 'currencies.json') },
  dog_breeds: { label: 'Dog Breeds', kind: 'list',       file: path.join(__dirname, 'public', 'topics', 'dog_breeds.json') }
};

function loadJSON(file) {
  try {
    let txt = fs.readFileSync(file, 'utf8');
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
    return JSON.parse(txt);
  } catch {
    return null;
  }
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
  const CANON = new Map();
  const names = [];
  for (const item of arr || []) {
    const name = item.name;
    if (!name) continue;
    names.push(name);
    CANON.set(normalizeName(name), name);
    if (item.code) CANON.set(normalizeName(item.code), name);
    for (const alias of (item.aliases || [])) CANON.set(normalizeName(alias), name);
  }
  return {
    toCanonical(input) { return CANON.get(normalizeName(input)) || null; },
    canonicalList: names
  };
}

// Some handy aliases
const COUNTRY_ALIASES = new Map(Object.entries({
  'usa': 'United States','us': 'United States','united states of america':'United States',
  'uk':'United Kingdom','uae':'United Arab Emirates','ivory coast':'Côte d’Ivoire',
  'swaziland':'Eswatini','czech republic':'Czechia','burma':'Myanmar',
  'vatican':'Vatican City','vatican city':'Vatican City','saudi':'Saudi Arabia',
  'drc':'Democratic Republic of the Congo','congo kinshasa':'Democratic Republic of the Congo',
  'republic of the congo':'Republic of the Congo','congo brazzaville':'Republic of the Congo',
  'south korea':'South Korea','north korea':'North Korea','palestine':'State of Palestine','turkiye':'Turkey'
}));
const CAPITAL_ALIASES = new Map(Object.entries({
  'washington dc': 'Washington, D.C.','washington d c':'Washington, D.C.',
  'ulan bator':'Ulaanbaatar','kiev':'Kyiv','pnom penh':'Phnom Penh'
}));

function loadTopic(topicKey) {
  const def = TOPIC_DEFS[topicKey] || TOPIC_DEFS.countries;
  const data = loadJSON(def.file);
  if (!data && topicKey !== 'countries') return loadTopic('countries');

  if (def.kind === 'currencies') {
    return { label: def.label, key: topicKey, ...buildCurrenciesValidator(Array.isArray(data) ? data : []) };
  }
  if (def.kind === 'list') {
    const aliases =
      topicKey === 'countries' ? COUNTRY_ALIASES :
      topicKey === 'capitals'  ? CAPITAL_ALIASES  : new Map();
    return { label: def.label, key: topicKey, ...buildListValidator(Array.isArray(data) ? data : [], aliases) };
  }
  return { label: def.label, key: topicKey, ...buildListValidator([]) };
}

// ---------- Room State ----------
/**
rooms[roomCode] = {
  mode: 'solo' | 'pvp',        // solo, quick-match, or private room (both pvp)
  hostId: string | null,       // for private rooms
  players: [{ id, name, socketId, alive, joinedAt, score }],
  phase: 'lobby' | 'playing' | 'ended',
  used: Set<string>,
  order: string[],
  idx: number,
  perTurn: number,
  timers: { interval?, timeout?, remaining },
  round: { pending: Set<string>, answered: number } | null,
  topicKey: string,
  topic: { label, key, toCanonical(), canonicalList }
}
*/
const rooms = Object.create(null);

// Broadcast to room
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

// ---------- End states ----------
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

// ---------- PvP round orchestration ----------
function beginRound(room, startIdx){
  const aliveIds = aliveIdsInOrder(room);
  room.round = { pending: new Set(aliveIds), answered: 0 };
  if (typeof startIdx === 'number') room.idx = startIdx;
  // ensure idx alive
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

// ---------- Turn/timer ----------
function startPvpTurn(roomCode){
  const room = rooms[roomCode]; if(!room || room.phase!=='playing' || room.mode==='solo') return;
  clearTimers(room);

  // ensure current alive
  let currentId = room.order[room.idx];
  let current = room.players.find(p => p.id === currentId);
  if (!current || !current.alive) {
    const ni = nextAliveIndex(room, room.idx);
    if (ni === -1) { handleRoundEnd(roomCode); return; }
    room.idx = ni; currentId = room.order[room.idx]; current = room.players.find(p=>p.id===currentId);
  }

  room.timers.remaining = room.perTurn;
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
  io.to(roomCode).emit('turn:start', { currentPlayerId: currentId, remaining: room.timers.remaining });

  room.timers.interval = setInterval(() => {
    room.timers.remaining -= 1;
    io.to(roomCode).emit('turn:tick', { remaining: Math.max(0, room.timers.remaining) });
  }, 1000);

  room.timers.timeout = setTimeout(() => {
    io.to(roomCode).emit('turn:tick', { remaining: 0 });
    clearTimers(room);
    io.to(roomCode).emit('turn:timeout', { playerId: currentId });
    soloOver(roomCode, 'timeout');
  }, room.perTurn * 1000);
}

// ---------- Matchmaking (Quick Match) ----------
const queues = new Map(); // key -> [{ socketId, name }]
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

    // dedupe names
    const seen = new Set();
    for (const p of players) {
      let base = p.name, cand = base, n = 2;
      while (seen.has(cand.toLowerCase())) cand = `${base} ${n++}`;
      seen.add(cand.toLowerCase()); p.name = cand;
    }

    const topic = loadTopic(topicKey || 'countries');

    rooms[roomCode] = {
      mode: 'pvp',
      hostId: null, // not used in quick match
      players,
      phase: 'playing',
      used: new Set(),
      order: shuffle(players.map(p => p.id)),
      idx: 0,
      perTurn,
      timers: { remaining: perTurn },
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

  if (wasHost && room.players.length > 0) {
    room.hostId = room.players[0].id; // pass host to first player
  }

  if (room.players.length === 0) {
    clearTimers(room);
    delete rooms[roomCode];
    io.to(socket.id).emit('room:left', { ok: true });
    return;
  }

  if (room.phase === 'playing') {
    if (wasCurrent) {
      if (room.round && room.round.pending) room.round.pending.delete(socket.id);
      if (room.round && room.round.pending.size === 0) {
        handleRoundEnd(roomCode);
      } else {
        room.idx = Math.max(0, Math.min(orderIdx, room.order.length - 1));
        startPvpTurn(roomCode);
      }
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
    const roomCode = makeRoomCode();
    const secs = clamp(Number(perTurn) || 10, 5, 120);
    const pname = (name || 'You').trim() || 'You';
    const topic = loadTopic(TOPIC_DEFS[topicKey] ? topicKey : 'countries');

    rooms[roomCode] = {
      mode: 'solo',
      hostId: socket.id,
      players: [{ id: socket.id, name: pname, socketId: socket.id, alive: true, joinedAt: Date.now(), score: 0 }],
      phase: 'playing',
      used: new Set(),
      order: [socket.id],
      idx: 0,
      perTurn: secs,
      timers: { remaining: secs },
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
    const size = clamp((Number(opponents) || 1) + 1, 2, 8);
    const secs = clamp(Number(perTurn) || 15, 5, 120);
    const topic = (TOPIC_DEFS[topicKey] ? topicKey : 'countries');
    const key = queueKey(size, secs, topic);

    let arr = queues.get(key); if (!arr) { arr = []; queues.set(key, arr); }
    if (arr.findIndex(w => w.socketId === socket.id) === -1) {
      arr.push({ socketId: socket.id, name: (name || 'Player').trim() || 'Player' });
    }
    socket.data.matchKey = key;

    socket.emit('match:searching', { size, perTurn: secs, topicLabel: TOPIC_DEFS[topic].label });
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

  // PRIVATE ROOMS
  socket.on('room:create', ({ name, topicKey }) => {
    if (socket.data.roomCode) safeLeaveRoom(socket);
    const roomCode = makeRoomCode();
    const pname = (name || 'Host').trim() || 'Host';
    const topic = loadTopic(TOPIC_DEFS[topicKey] ? topicKey : 'countries');

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

    const trimmed = (name || '').trim();
    if (!trimmed) return socket.emit('error:msg', { message: 'Name is required.' });

    let candidate = trimmed, suffix = 2;
    const names = new Set(room.players.map(p => p.name.toLowerCase()));
    while (names.has(candidate.toLowerCase())) candidate = `${trimmed} ${suffix++}`;

    room.players.push({ id: socket.id, name: candidate, socketId: socket.id, alive: true, joinedAt: Date.now(), score: 0 });
    room.order.push(socket.id);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.name = candidate;
    broadcastRoom(roomCode);
  });

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

    // Shuffle order each game start for fairness
    room.order = shuffle(room.players.map(p => p.id));
    room.idx = 0;

    if (TOPIC_DEFS[topicKey]) {
      const t = loadTopic(topicKey);
      room.topicKey = t.key;
      room.topic = t;
    }

    broadcastRoom(roomCode);
    beginRound(room, 0);
    startPvpTurn(roomCode);
  });

  // Reset to lobby (return to lobby)
  socket.on('game:reset', ({ roomCode }) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const room = rooms[roomCode]; if (!room) return;

    const isPrivateRoom = !!room.hostId; // quick match has hostId = null
    if (!isPrivateRoom) return; // only private rooms have a reusable lobby

    // During lobby/playing, only host can reset; after 'ended', allow any player to reset
    const isEnded = room.phase === 'ended';
    if (!isEnded && socket.id !== room.hostId) return;

    clearTimers(room);
    room.phase = 'lobby';
    room.used = new Set();
    room.round = null;
    for (const p of room.players) { p.alive = true; p.score = 0; }

    // Keep roster; order rebuilt (host can reshuffle at start)
    room.order = room.players.map(p => p.id);
    room.idx = 0;

    broadcastRoom(roomCode);
  });

  // Leave/Navigate
  socket.on('room:leave', () => {
    safeLeaveRoom(socket);
  });

  // Answers (shared)
  socket.on('answer:submit', ({ roomCode, answer }) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const room = rooms[roomCode]; if (!room || room.phase !== 'playing') return;
    const currentId = room.order[room.idx];
    if (socket.id !== currentId) return socket.emit('error:msg', { message: 'Not your turn.' });

    const canonical = room.topic?.toCanonical(answer || '');
    if (!canonical) return socket.emit('answer:rejected', { reason: 'invalid' });
    if (room.used.has(canonical)) return socket.emit('answer:rejected', { reason: 'repeated', country: canonical });

    // accept
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

  // Disconnect (immediate removal; remaining continue)
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

server.listen(PORT, () => {
  console.log(`Naming Game server running at http://localhost:${PORT}`);
});
