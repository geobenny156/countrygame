(() => {
  const socket = io();

  // Sections
  const elLobby = document.getElementById('lobby');
  const elGame = document.getElementById('game');
  const overlay = document.getElementById('resultOverlay');

  // SOLO
  const soloName = document.getElementById('soloName');
  const soloPerTurn = document.getElementById('soloPerTurn');
  const soloTopic = document.getElementById('soloTopic');
  const btnStartSolo = document.getElementById('btnStartSolo');

  // Quick Match
  const qmName = document.getElementById('qmName');
  const qmOpponents = document.getElementById('qmOpponents');
  const qmPerTurn = document.getElementById('qmPerTurn');
  const qmTopic = document.getElementById('qmTopic');
  const btnFindMatch = document.getElementById('btnFindMatch');
  const btnCancelMatch = document.getElementById('btnCancelMatch');
  const matchStatus = document.getElementById('matchStatus');

  // Private Room
  const elCreateName = document.getElementById('createName');
  const elJoinCode = document.getElementById('joinCode');
  const elJoinName = document.getElementById('joinName');
  const topicSelect = document.getElementById('topicSelect');
  const btnCreate = document.getElementById('btnCreate');
  const btnJoin = document.getElementById('btnJoin');

  // Game panel
  const roomCodeLabel = document.getElementById('roomCodeLabel');
  const modeLabel = document.getElementById('modeLabel');
  const topicLabel = document.getElementById('topicLabel');
  const perTurnLabel = document.getElementById('perTurnLabel');
  const phaseBadge = document.getElementById('phaseBadge');
  const playersList = document.getElementById('players');
  const hostPanel = document.getElementById('hostPanel');
  const perTurnInput = document.getElementById('perTurnInput');
  const hostTopic = document.getElementById('hostTopic');
  const btnStart = document.getElementById('btnStart');
  const btnReset = document.getElementById('btnReset');
  const currentName = document.getElementById('currentName');
  const timer = document.getElementById('timer');
  const answerInput = document.getElementById('answerInput');
  const btnSubmit = document.getElementById('btnSubmit');
  const usedList = document.getElementById('usedList');
  const answerHint = document.getElementById('answerHint');

  // Overlay
  const resultTitle = document.getElementById('resultTitle');
  const scoreboard = document.getElementById('scoreboard');
  const btnPlayAgain = document.getElementById('btnPlayAgain');

  let state = {
    youId: null,
    roomCode: null,
    hostId: null,
    phase: 'lobby',
    perTurn: 15,
    topicKey: 'countries',
    topicLabel: 'Countries',
    mode: 'pvp',
    players: [],
    currentPlayerId: null,
    used: [],
    searching: false,
    overlayVisible: false
  };

  function setView(view) {
    if (view === 'lobby') {
      elLobby.classList.remove('hidden');
      elGame.classList.add('hidden');
    } else {
      elLobby.classList.add('hidden');
      elGame.classList.remove('hidden');
    }
    overlay.classList.toggle('hidden', !state.overlayVisible);
  }

  function render() {
    if (!state.roomCode) { setView('lobby'); } else { setView('game'); }
    roomCodeLabel.textContent = state.roomCode || '—';
    modeLabel.textContent = state.mode === 'solo' ? 'Solo' : 'Multiplayer';
    topicLabel.textContent = state.topicLabel || '—';
    perTurnLabel.textContent = state.perTurn;
    phaseBadge.textContent = state.phase ? state.phase[0].toUpperCase() + state.phase.slice(1) : '—';

    // Players (highlight current — your CSS already styles .current)
    playersList.innerHTML = '';
    state.players.forEach(p => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = p.name;
      name.className = 'name ' + (p.alive ? 'alive' : 'dead');
      if (p.id === state.youId) name.classList.add('you');
      if (p.id === state.currentPlayerId) li.classList.add('current');
      const meta = document.createElement('span');
      meta.textContent = `Score: ${p.score}` + (p.id === state.hostId ? ' • Host' : '');
      li.appendChild(name);
      li.appendChild(meta);
      playersList.appendChild(li);
    });

    // Host controls only in private lobby
    hostPanel.classList.toggle('hidden', !(state.youId === state.hostId && state.phase === 'lobby' && state.mode === 'pvp'));

    // Current turn label
    const current = state.players.find(p => p.id === state.currentPlayerId);
    currentName.textContent = current ? current.name : '—';

    // Input enablement
    const yourTurn = state.phase === 'playing' && state.currentPlayerId === state.youId;
    answerInput.disabled = !yourTurn;
    btnSubmit.disabled = !yourTurn;
    answerInput.placeholder = yourTurn ? 'Type an answer...' : (state.phase === 'playing' ? 'Wait for your turn...' : 'Game not started');

    // Used answers
    usedList.innerHTML = '';
    state.used.forEach(c => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = c;
      usedList.appendChild(chip);
    });

    // Match status
    matchStatus.textContent = (!state.roomCode && state.searching) ? 'Searching for players...' : '';
  }

  function showOverlay(show) {
    state.overlayVisible = !!show;
    overlay.classList.toggle('hidden', !state.overlayVisible);
  }

  // --- Leave room, then run an action
  function leaveThen(action) {
    if (state.roomCode) {
      socket.once('room:left', action);
      socket.emit('room:leave');
    } else {
      action();
    }
  }

  // --- Queueing (random match)
  function queueForMatch() {
    state.searching = true;
    socket.emit('match:queue', {
      opponents: Number(qmOpponents.value || 3),
      perTurn: Number(qmPerTurn.value || 15),
      topicKey: qmTopic.value,
      name: qmName.value
    });
    render();
  }

  // UI events
  btnStartSolo.addEventListener('click', () => leaveThen(() => {
    socket.emit('solo:start', {
      perTurn: Number(soloPerTurn.value || 10),
      topicKey: soloTopic.value,
      name: soloName.value
    });
  }));

  btnFindMatch.addEventListener('click', () => leaveThen(queueForMatch));
  btnCancelMatch.addEventListener('click', () => socket.emit('match:cancel'));

  btnCreate.addEventListener('click', () => leaveThen(() => {
    socket.emit('room:create', { name: elCreateName.value });
  }));

  btnJoin.addEventListener('click', () => leaveThen(() => {
    socket.emit('room:join', { roomCode: (elJoinCode.value || '').toUpperCase().trim(), name: elJoinName.value });
  }));

  btnStart.addEventListener('click', () => {
    socket.emit('game:start', { roomCode: state.roomCode, perTurn: Number(perTurnInput.value || 15), topicKey: hostTopic.value });
  });
  btnReset.addEventListener('click', () => socket.emit('game:reset', { roomCode: state.roomCode }));

  btnSubmit.addEventListener('click', () => {
    const val = answerInput.value.trim();
    if (!val) return;
    socket.emit('answer:submit', { roomCode: state.roomCode, answer: val });
    answerInput.value = '';
  });
  answerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnSubmit.click(); });

  btnPlayAgain.addEventListener('click', () => {
    // Leave server room so you can immediately re-queue, start solo, or create/join
    if (state.roomCode) socket.emit('room:leave');
    state = { ...state, roomCode: null, phase: 'lobby', used: [], players: [], currentPlayerId: null };
    showOverlay(false);
    render();
  });

  // Socket events
  socket.on('connect', () => { state.youId = socket.id; });

  socket.on('room:created', ({ roomCode }) => {
    state.roomCode = roomCode;
    state.phase = 'lobby';
    state.mode = 'pvp';
    hostTopic.value = topicSelect?.value || 'countries';
    showOverlay(false);
    render();
  });

  socket.on('room:update', (payload) => {
    state.roomCode = payload.roomCode;
    state.hostId = payload.hostId;
    state.phase = payload.phase;
    state.perTurn = payload.perTurn;
    state.topicKey = payload.topicKey || 'countries';
    state.topicLabel = payload.topicLabel || 'Countries';
    state.mode = payload.mode || 'pvp';
    state.players = payload.players;
    state.currentPlayerId = payload.currentPlayerId;
    state.used = payload.used;
    if (state.phase === 'lobby' && hostTopic) hostTopic.value = state.topicKey;
    render();
  });

  // Matchmaking
  socket.on('match:searching', ({ size, perTurn, topicLabel: tl }) => {
    state.searching = true;
    qmPerTurn.value = perTurn;
    matchStatus.textContent = `Searching for ${size-1} opponents in ${tl}...`;
  });
  socket.on('match:found', () => { state.searching = false; });
  socket.on('match:cancelled', () => { state.searching = false; render(); });

  // Turn + timer
  socket.on('turn:start', ({ currentPlayerId, remaining }) => {
    state.currentPlayerId = currentPlayerId;
    timer.textContent = remaining + 's';
    answerHint.textContent = '';
    render();
  });
  socket.on('turn:tick', ({ remaining }) => { timer.textContent = Math.max(0, remaining) + 's'; });
  socket.on('turn:timeout', () => { timer.textContent = '0s'; });

  // Answers
  socket.on('answer:accepted', () => { answerHint.textContent = ''; });
  socket.on('answer:rejected', ({ reason, country }) => {
    if (reason === 'invalid') answerHint.textContent = 'Not recognized. Try another.';
    else if (reason === 'repeated') answerHint.textContent = `"${country}" is already used. Pick a different one.`;
    else answerHint.textContent = 'Rejected. Try again.';
  });

  // Results (PvP)
  function renderBoard(title, players, winnerId) {
    phaseBadge.textContent = 'Ended';
    resultTitle.textContent = title;
    const sorted = [...players].sort((a, b) => b.score - a.score);
    scoreboard.innerHTML = '<h3>Scoreboard</h3>';
    const ul = document.createElement('ul'); ul.className = 'board';
    sorted.forEach((p, i) => {
      const li = document.createElement('li');
      li.textContent = `${i + 1}. ${p.name} — ${p.score}`;
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

  // Results (Solo)
  socket.on('solo:over', ({ reason, topicLabel: tl, usedCount, total, players }) => {
    phaseBadge.textContent = 'Ended';
    const p = players && players[0] ? players[0] : { name: 'You', score: usedCount || 0 };
    const title =
      reason === 'completed' ? '🎉 Completed the list!' :
      'Game Over';
    resultTitle.textContent = `${title}`;
    scoreboard.innerHTML = '';
    const info = document.createElement('div');
    info.innerHTML =
      `<p><strong>${p.name}</strong> — Score: <strong>${p.score}</strong></p>` +
      (total ? `<p>${tl}: ${usedCount} / ${total} correct</p>` : `<p>${tl}: ${usedCount} correct</p>`);
    scoreboard.appendChild(info);
    showOverlay(true);
  });

  socket.on('error:msg', ({ message }) => { matchStatus.textContent = message; });
})();
