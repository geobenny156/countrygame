(() => {
  const socket = io();

  // Elements
  const playerNameEl = document.getElementById('playerName');
  const modeLabel = document.getElementById('modeLabel');
  const topicLabel = document.getElementById('topicLabel');
  const perTurnLabel = document.getElementById('perTurnLabel');

  const roomCodeWrap = document.getElementById('roomCodeWrap');
  const roomCodeLabel = document.getElementById('roomCodeLabel');

  const btnLeave = document.getElementById('btnLeave');
  const btnCancel = document.getElementById('btnCancel');
  const searchBox = document.getElementById('searchBox');
  const searchMsg = document.getElementById('searchMsg');

  const playersList = document.getElementById('players');
  const currentName = document.getElementById('currentName');
  const timerEl = document.getElementById('timer');
  const answerInput = document.getElementById('answerInput');
  const btnSubmit = document.getElementById('btnSubmit');
  const answerHint = document.getElementById('answerHint');
  const usedList = document.getElementById('usedList');

  const hostPanel = document.getElementById('hostPanel');
  const perTurnInput = document.getElementById('perTurnInput');
  const hostTopic = document.getElementById('hostTopic');
  const btnStart = document.getElementById('btnStart');
  const btnReset = document.getElementById('btnReset');

  const overlay = document.getElementById('resultOverlay');
  const resultTitle = document.getElementById('resultTitle');
  const scoreboard = document.getElementById('scoreboard');
  const btnPlayAgain = document.getElementById('btnPlayAgain');
  const btnReturnLobby = document.getElementById('btnReturnLobby');

  // Pull settings
  NG.requireNameOrRedirect('index.html');
  NG.requireTopicOrRedirect('topics.html');

  const name = NG.getName();
  const topicKey = NG.getTopicKey();
  const topicLbl = NG.getTopicLabel();
  const rules = NG.getRules(); // {mode, perTurn, opponents, roomAction, roomCode}

  playerNameEl.textContent = name;
  modeLabel.textContent = rules.mode === 'solo' ? 'Solo' : (rules.mode === 'private' ? 'Private Room' : 'Multiplayer');
  topicLabel.textContent = topicLbl;
  perTurnLabel.textContent = rules.perTurn;

  // Local UI state
  let state = {
    youId: null,
    roomCode: null,
    hostId: null,
    phase: 'lobby',
    perTurn: rules.perTurn,
    topicKey,
    topicLabel: topicLbl,
    mode: rules.mode,
    players: [],
    currentPlayerId: null,
    used: [],
    overlayVisible: false,
    searching: false
  };

  function showOverlay(show) {
    state.overlayVisible = !!show;
    overlay.classList.toggle('hidden', !state.overlayVisible);
  }

  function renderPlayers() {
    playersList.innerHTML = '';
    state.players.forEach(p => {
      const li = document.createElement('li');
      const nm = document.createElement('span');
      nm.textContent = p.name;
      nm.className = 'name ' + (p.alive ? 'alive' : 'dead');
      if (p.id === state.youId) nm.classList.add('you');
      if (p.id === state.currentPlayerId) li.classList.add('current');
      const meta = document.createElement('span');
      meta.textContent = `Score: ${p.score}` + (state.hostId === p.id ? ' • Host' : '');
      li.appendChild(nm); li.appendChild(meta);
      playersList.appendChild(li);
    });
  }

  function renderUsed() {
    usedList.innerHTML = '';
    state.used.forEach(val => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = val;
      usedList.appendChild(chip);
    });
  }

  function setSearching(on, message) {
    state.searching = on;
    searchBox.classList.toggle('hidden', !on);
    btnCancel.classList.toggle('hidden', !(on && state.mode === 'pvp'));
    searchMsg.textContent = message || (on ? 'Searching for players…' : '');
  }

  // Leave Game → go Home
  btnLeave.addEventListener('click', () => {
    if (state.searching && state.mode === 'pvp') {
      try { socket.emit('match:cancel'); } catch {}
    }
    if (state.roomCode) {
      socket.once('room:left', () => { location.href = 'index.html'; });
      socket.emit('room:leave');
    } else {
      location.href = 'index.html';
    }
  });

  btnCancel.addEventListener('click', () => socket.emit('match:cancel'));
  btnPlayAgain.addEventListener('click', () => {
    if (state.roomCode) socket.emit('room:leave');
    showOverlay(false);
    location.href = 'index.html';
  });

  // Return to Lobby (private rooms only; after end any player can trigger)
  btnReturnLobby.addEventListener('click', () => {
    if (state.roomCode && state.hostId) {
      socket.emit('game:reset', { roomCode: state.roomCode });
      // overlay will hide when we receive room:update with phase='lobby'
    } else {
      // Quick match: no reusable lobby
      if (state.roomCode) socket.emit('room:leave');
      location.href = 'index.html';
    }
  });

  // Host actions (private room)
  btnStart?.addEventListener('click', () => {
    socket.emit('game:start', {
      roomCode: state.roomCode,
      perTurn: Number(perTurnInput.value || state.perTurn || 15),
      topicKey: hostTopic.value
    });
  });
  btnReset?.addEventListener('click', () => socket.emit('game:reset', { roomCode: state.roomCode }));

  // Submit answer
  btnSubmit.addEventListener('click', () => {
    const val = answerInput.value.trim();
    if (!val) return;
    socket.emit('answer:submit', { roomCode: state.roomCode, answer: val });
    answerInput.value = '';
  });
  answerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnSubmit.click(); });

  // Socket lifecycle
  socket.on('connect', () => {
    state.youId = socket.id;

    if (rules.mode === 'solo') {
      setSearching(true, 'Starting solo game…');
      socket.emit('solo:start', { perTurn: rules.perTurn, topicKey, name });
    } else if (rules.mode === 'pvp') {
      setSearching(true, `Finding ${rules.opponents} opponent${rules.opponents>1?'s':''} in ${topicLbl}…`);
      socket.emit('match:queue', { opponents: rules.opponents, perTurn: rules.perTurn, topicKey, name });
    } else if (rules.mode === 'private') {
      roomCodeWrap.classList.remove('hidden');
      setSearching(false, '');
      if (rules.roomAction === 'create') {
        socket.emit('room:create', { name, topicKey });
      } else {
        setSearching(true, 'Joining room…');
        socket.emit('room:join', { roomCode: rules.roomCode, name });
      }
    }
  });

  // Private: room created acknowledgement
  socket.on('room:created', ({ roomCode }) => {
    state.roomCode = roomCode;
    roomCodeLabel.textContent = roomCode;
  });

  // Shared room state
  socket.on('room:update', (payload) => {
    state.roomCode = payload.roomCode;
    state.hostId = payload.hostId;
    state.phase = payload.phase;
    state.perTurn = payload.perTurn;
    state.topicKey = payload.topicKey || topicKey;
    state.topicLabel = payload.topicLabel || topicLbl;
    state.mode = payload.mode || rules.mode;
    state.players = payload.players || [];
    state.currentPlayerId = payload.currentPlayerId;
    state.used = payload.used || [];

    // Room code visibility
    roomCodeLabel.textContent = state.roomCode || '—';
    roomCodeWrap.classList.toggle('hidden', !(state.mode !== 'solo' && state.roomCode));

    // Show Return-to-Lobby only for private rooms (hostId exists)
    const isPrivateRoom = !!payload.hostId;
    btnReturnLobby.classList.toggle('hidden', !isPrivateRoom);

    // Host panel only if: private room + lobby + you are host
    const iAmHost = state.youId && state.hostId === state.youId;
    hostPanel.classList.toggle('hidden', !(state.mode !== 'solo' && state.phase === 'lobby' && iAmHost));
    if (iAmHost && hostTopic) hostTopic.value = state.topicKey;
    if (iAmHost && perTurnInput) perTurnInput.value = state.perTurn || rules.perTurn;

    // Close overlay if we returned to lobby (e.g., after Return to Lobby)
    if (isPrivateRoom && state.phase === 'lobby') showOverlay(false);

    // Enable/disable input for turns
    const yourTurn = state.phase === 'playing' && state.currentPlayerId === state.youId;
    answerInput.disabled = !yourTurn;
    btnSubmit.disabled = !yourTurn;
    answerInput.placeholder = yourTurn ? 'Type an answer…' :
      (state.phase === 'playing' ? 'Wait for your turn…' : 'Game not started');

    const cur = state.players.find(p => p.id === state.currentPlayerId);
    currentName.textContent = cur ? cur.name : '—';

    setSearching(false, '');
    renderPlayers();
    renderUsed();
  });

  // Turn cycle
  socket.on('turn:start', ({ currentPlayerId, remaining }) => {
    state.currentPlayerId = currentPlayerId;
    timerEl.textContent = remaining + 's';
    answerHint.textContent = '';
    const cur = state.players.find(p => p.id === currentPlayerId);
    currentName.textContent = cur ? cur.name : '—';
    const yourTurn = currentPlayerId === state.youId;
    answerInput.disabled = !yourTurn;
    btnSubmit.disabled = !yourTurn;
    renderPlayers();
  });
  socket.on('turn:tick', ({ remaining }) => { timerEl.textContent = Math.max(0, remaining) + 's'; });
  socket.on('turn:timeout', () => { timerEl.textContent = '0s'; });

  // Answers
  socket.on('answer:accepted', () => { answerHint.textContent = ''; });
  socket.on('answer:rejected', ({ reason, country }) => {
    if (reason === 'invalid') answerHint.textContent = 'Not recognized. Try another.';
    else if (reason === 'repeated') answerHint.textContent = `"${country}" already used.`;
    else answerHint.textContent = 'Rejected. Try again.';
  });

  // Results
  function renderBoard(title, players, winnerId) {
    resultTitle.textContent = title;
    scoreboard.innerHTML = '<h3>Scoreboard</h3>';
    const ul = document.createElement('ul'); ul.className = 'board';
    players.sort((a,b)=>b.score-a.score).forEach((p,i) => {
      const li = document.createElement('li');
      li.textContent = `${i+1}. ${p.name} — ${p.score}`;
      if (winnerId && p.id === winnerId) li.classList.add('winner');
      ul.appendChild(li);
    });
    scoreboard.appendChild(ul);
    showOverlay(true);
  }
  socket.on('game:over', ({ winnerId, players }) => {
    const youWon = winnerId && winnerId === state.youId;
    renderBoard(youWon ? '🏆 You won!' : 'You lost', players, winnerId);
  });
  socket.on('game:draw', ({ players }) => { renderBoard('Draw', players, null); });
  socket.on('solo:over', ({ reason, topicLabel, usedCount, total, players }) => {
    const p = players && players[0] ? players[0] : { name: 'You', score: usedCount || 0 };
    resultTitle.textContent = reason === 'completed' ? '🎉 Completed the list!' : 'Game Over';
    scoreboard.innerHTML = '';
    const info = document.createElement('div');
    info.innerHTML =
      `<p><strong>${p.name}</strong> — Score: <strong>${p.score}</strong></p>` +
      (total ? `<p>${topicLabel}: ${usedCount} / ${total} correct</p>` : `<p>${topicLabel}: ${usedCount} correct</p>`);
    scoreboard.appendChild(info);
    showOverlay(true);
  });

  // Errors
  socket.on('error:msg', ({ message }) => {
    if (rules.mode === 'private') {
      alert(message);
      location.href = 'rules.html';
    } else {
      searchMsg.textContent = message || 'Error';
    }
  });

  // Best-effort leave on navigation
  window.addEventListener('pagehide', () => {
    try { socket.emit('room:leave'); } catch {}
  });
})();
