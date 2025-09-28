(() => {
  // --- Socket ---
  const socket = io();

  // If server rejects our name, bounce back to Home to change it
  socket.on('name:invalid', () => {
    alert('That display name is not allowed. Please pick another.');
    location.href = 'account.html';
  });

  // --- Signed-in check (for saving scores) ---
  async function fetchMe() {
    try { const r = await fetch('/api/auth/me'); const j = await r.json(); return j.user || null; } catch { return null; }
  }
  let signedInUser = null;
  fetchMe().then(u => { signedInUser = u; });

  async function recordScore(payload) {
    if (!signedInUser) return; // guests don't save
    try {
      await fetch('/api/scores/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch {}
  }

  // --- Elements ---
  const playerNameEl   = document.getElementById('playerName');
  const modeLabel      = document.getElementById('modeLabel');
  const topicLabel     = document.getElementById('topicLabel');
  const perTurnLabel   = document.getElementById('perTurnLabel');

  const roomCodeWrap   = document.getElementById('roomCodeWrap');
  const roomCodeLabel  = document.getElementById('roomCodeLabel');

  const spectatorBanner= document.getElementById('spectatorBanner');
  const btnLeave       = document.getElementById('btnLeave');
  const btnCancel      = document.getElementById('btnCancel');
  const searchBox      = document.getElementById('searchBox');
  const searchMsg      = document.getElementById('searchMsg');

  const playersList    = document.getElementById('players');
  const currentName    = document.getElementById('currentName');
  const timerEl        = document.getElementById('timer');

  const answerForm     = document.getElementById('answerForm');
  const answerInput    = document.getElementById('answerInput');
  const btnSubmit      = document.getElementById('btnSubmit');
  const answerHint     = document.getElementById('answerHint');
  const usedList       = document.getElementById('usedList');

  const hostPanel      = document.getElementById('hostPanel');
  const perTurnInput   = document.getElementById('perTurnInput');
  const hostTopic      = document.getElementById('hostTopic');
  const btnStart       = document.getElementById('btnStart');
  const btnReset       = document.getElementById('btnReset');

  const overlay        = document.getElementById('resultOverlay');
  const resultTitle    = document.getElementById('resultTitle');
  const scoreboard     = document.getElementById('scoreboard');
  const btnPlayAgain   = document.getElementById('btnPlayAgain');
  const btnReturnLobby = document.getElementById('btnReturnLobby');

  // --- Mini-game elements ---
  const spectatorActions = document.getElementById('spectatorActions');
  const btnStartMini   = document.getElementById('btnStartMini');
  const btnStopMini    = document.getElementById('btnStopMini');
  const miniPanel      = document.getElementById('miniGamePanel');
  const mgTopicLabel   = document.getElementById('mgTopicLabel');
  const mgPrompt       = document.getElementById('mgPrompt');
  const mgOptions      = document.getElementById('mgOptions');
  const mgTextWrap     = document.getElementById('mgTextWrap');
  const mgTextInput    = document.getElementById('mgTextInput');
  const mgSubmit       = document.getElementById('mgSubmit');
  const mgSkip         = document.getElementById('mgSkip');
  const mgNext         = document.getElementById('mgNext');
  const mgHint         = document.getElementById('mgHint');
  const mgScoreLabel   = document.getElementById('mgScoreLabel');
  const mgRemaining    = document.getElementById('mgRemainingLabel');

  // --- Pull settings (must exist) ---
  NG.requireNameOrRedirect('account.html');
  NG.requireTopicOrRedirect('topics.html');

  const name     = NG.getName();
  const topicKey = NG.getTopicKey();
  const topicLbl = NG.getTopicLabel();
  const rules    = NG.getRules(); // { mode, perTurn, opponents, roomAction, roomCode }

  playerNameEl.textContent = name;
  modeLabel.textContent    = rules.mode === 'solo' ? 'Solo' : (rules.mode === 'private' ? 'Private Room' : 'Multiplayer');
  topicLabel.textContent   = topicLbl;
  perTurnLabel.textContent = rules.perTurn;

  // --- Local UI state ---
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
    searching: false,
    isSpectator: false
  };

  // --- Mini-game state ---
  const MG = {
    active: false,
    idx: 0,
    score: 0,
    questions: [],
    reset() { this.active=false; this.idx=0; this.score=0; this.questions=[]; },
    cur() { return this.questions[this.idx] || null; },
    remaining() { return Math.max(0, this.questions.length - this.idx - 1); }
  };

  // --- Helpers ---
  function showOverlay(show) {
    state.overlayVisible = !!show;
    overlay.classList.toggle('hidden', !state.overlayVisible);
  }

  // New: allow mini-game only in multiplayer with >= 3 total players (current room count)
  function canOfferMiniGame() {
    const count = (state.players && state.players.length) ? state.players.length : 0;
    return state.mode !== 'solo' && state.phase === 'playing' && count >= 3;
  }

  function showSpectatorBanner(show) {
    spectatorBanner.classList.toggle('hidden', !show);
    const showActions = show && canOfferMiniGame();
    if (spectatorActions) spectatorActions.classList.toggle('hidden', !showActions);
    if (btnStartMini) btnStartMini.classList.toggle('hidden', !showActions || MG.active);
    if (btnStopMini)  btnStopMini.classList.toggle('hidden', !showActions || !MG.active);
    if (!showActions && MG.active) { MG.reset(); showMini(false); }
  }

  function renderPlayers() {
    playersList.innerHTML = '';
    state.players.forEach(p => {
      const li = document.createElement('li');
      const nm = document.createElement('span');
      nm.textContent = p.name;
      nm.className = 'name ' + (p.alive ? 'alive' : 'dead');
      if (p.id === state.youId) nm.classList.add('you');
      if (p.id === state.currentPlayerId) li.classList.add('current'); // highlight current turn
      const meta = document.createElement('span');
      meta.textContent = `Score: ${p.score}` + (state.hostId === p.id ? ' • Host' : '');
      li.appendChild(nm);
      li.appendChild(meta);
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
    btnCancel?.classList.toggle('hidden', !(on && state.mode === 'pvp'));
    searchMsg.textContent = message || (on ? 'Searching for players…' : '');
  }

  // --- Disable browser remembered values on the answer input ---
  function primeAnswerInput() {
    if (!answerInput) return;
    const rnd = Math.random().toString(36).slice(2) + Date.now();
    answerInput.setAttribute('name', 'answer_' + rnd);
    answerForm?.setAttribute('autocomplete', 'off'); answerForm?.setAttribute('novalidate', '');
    answerInput.setAttribute('autocomplete', 'off');
    answerInput.setAttribute('autocapitalize', 'off');
    answerInput.setAttribute('autocorrect', 'off');
    answerInput.setAttribute('spellcheck', 'false');
    answerInput.setAttribute('aria-autocomplete', 'none');
    answerInput.setAttribute('inputmode', 'text');
    answerInput.setAttribute('data-lpignore', 'true');
  }
  primeAnswerInput();

  // --- Anti‑cheat: disable paste/drag/drop into the answer box ---
  function blockPasteLike(e, msg = 'Pasting is disabled.') {
    try { e.preventDefault(); } catch {}
    if (answerHint) answerHint.textContent = msg;
  }
  if (answerInput) {
    answerInput.addEventListener('keydown', (e) => {
      const isPasteKey = (e.key === 'v' || e.key === 'V') && (e.ctrlKey || e.metaKey);
      if (isPasteKey) blockPasteLike(e);
    });
    answerInput.addEventListener('paste', (e) => blockPasteLike(e));
    answerInput.addEventListener('drop', (e) => blockPasteLike(e));
    answerInput.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop' || e.inputType === 'insertFromPasteAsQuotation') {
        blockPasteLike(e);
      }
    });
    answerInput.addEventListener('auxclick', (e) => { if (e.button === 1) blockPasteLike(e); });
  }

  // --- Navigation / Buttons ---
  answerForm?.addEventListener('submit', (e) => { e.preventDefault(); btnSubmit.click(); return false; });

  btnLeave.addEventListener('click', () => {
    if (state.searching && state.mode === 'pvp') { try { socket.emit('match:cancel'); } catch {} }
    if (state.roomCode) {
      socket.once('room:left', () => { location.href = 'index.html'; });
      socket.emit('room:leave');
    } else {
      location.href = 'index.html';
    }
  });

  btnCancel?.addEventListener('click', () => socket.emit('match:cancel'));
  btnPlayAgain.addEventListener('click', () => {
    if (state.roomCode) socket.emit('room:leave');
    showOverlay(false);
    location.href = 'topics.html';
  });
  btnReturnLobby.addEventListener('click', () => {
    if (state.roomCode && state.hostId) {
      socket.emit('game:reset', { roomCode: state.roomCode });
    } else {
      if (state.roomCode) socket.emit('room:leave');
      location.href = 'index.html';
    }
  });

  // Host panel (private room)
  btnStart?.addEventListener('click', () => {
    socket.emit('game:start', { roomCode: state.roomCode, perTurn: Number(perTurnInput.value || state.perTurn || 15), topicKey: hostTopic.value });
  });
  btnReset?.addEventListener('click', () => socket.emit('game:reset', { roomCode: state.roomCode }));

  // Answer input
  btnSubmit.addEventListener('click', () => {
    if (state.isSpectator) return;
    const val = answerInput.value.trim();
    if (!val) return;
    socket.emit('answer:submit', { roomCode: state.roomCode, answer: val });
    answerInput.value = '';
    primeAnswerInput();
  });
  answerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnSubmit.click(); });

  // --- Mini-game (Trivia) ---
  function showMini(show) {
    miniPanel?.classList.toggle('hidden', !show);
    if (spectatorActions) spectatorActions.classList.toggle('hidden', show ? false : spectatorBanner.classList.contains('hidden'));
    if (btnStartMini) btnStartMini.classList.toggle('hidden', show || !canOfferMiniGame());
    if (btnStopMini)  btnStopMini.classList.toggle('hidden', !show);
  }
  function mgRenderStatus() {
    mgScoreLabel.textContent = `Score: ${MG.score}`;
    mgRemaining.textContent = `Remaining: ${MG.remaining()}`;
  }
  function mgRenderQuestion() {
    const q = MG.cur();
    if (!q) { mgPrompt.textContent = 'No more questions.'; mgOptions.innerHTML = ''; mgTextWrap.style.display='none'; return; }
    mgTopicLabel.textContent = state.topicLabel;
    mgPrompt.textContent = q.prompt;
    mgHint.textContent = '';

    // reset containers
    mgOptions.innerHTML = '';
    mgTextInput.value = '';
    mgTextWrap.style.display = 'none';

    if (q.type === 'mc') {
      q.options.forEach((opt, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'secondary'; btn.textContent = opt;
        btn.onclick = () => {
          const correct = idx === q.correctIndex;
          if (correct) { MG.score++; mgHint.textContent = 'Correct!'; }
          else { mgHint.textContent = `Incorrect. Correct answer: ${q.options[q.correctIndex]}`; }
          MG.idx++;
          mgRenderStatus(); mgRenderQuestion();
        };
        mgOptions.appendChild(btn);
      });
    } else if (q.type === 'tf') {
      ['True','False'].forEach((label, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'secondary'; btn.textContent = label;
        btn.onclick = () => {
          const user = (idx === 0);
          const correct = !!q.answerTrue === user;
          if (correct) { MG.score++; mgHint.textContent = 'Correct!'; }
          else { mgHint.textContent = `Incorrect. The statement is ${q.answerTrue ? 'True' : 'False'}.`; }
          MG.idx++;
          mgRenderStatus(); mgRenderQuestion();
        };
        mgOptions.appendChild(btn);
      });
    } else if (q.type === 'text') {
      mgTextWrap.style.display = '';
      mgSubmit.onclick = () => {
        const v = mgTextInput.value.trim();
        if (!v) return;
        const ok = (q.compare === 'case-insensitive')
          ? (v.toLowerCase() === q.answer.toLowerCase())
          : (v === q.answer);
        if (ok) { MG.score++; mgHint.textContent = 'Correct!'; }
        else { mgHint.textContent = `Incorrect. Correct answer: ${q.answer}`; }
        MG.idx++;
        mgRenderStatus(); mgRenderQuestion();
      };
    }
  }

  btnStartMini?.addEventListener('click', async () => {
    if (!state.isSpectator || !canOfferMiniGame()) return;
    btnStartMini.disabled = true; btnStartMini.textContent = 'Loading…';
    try {
      const r = await fetch(`/api/trivia/generate?topicKey=${encodeURIComponent(state.topicKey)}&n=120`);
      const j = await r.json();
      if (!j || !j.ok || !Array.isArray(j.questions) || j.questions.length === 0) {
        alert('Could not start trivia right now.');
        return;
      }
      MG.active = true; MG.idx=0; MG.score=0; MG.questions = j.questions;
      showMini(true);
      mgRenderStatus(); mgRenderQuestion();
    } catch {
      alert('Could not start trivia.');
    } finally {
      btnStartMini.disabled = false; btnStartMini.textContent = '🕹️ Play trivia while you wait';
      // If during loading the room dropped below 3, abort showing
      if (!canOfferMiniGame() || !state.isSpectator) { MG.reset(); showMini(false); }
    }
  });

  btnStopMini?.addEventListener('click', () => { MG.reset(); showMini(false); });

  mgNext?.addEventListener('click', () => { if (!MG.active) return; MG.idx++; mgRenderStatus(); mgRenderQuestion(); });
  mgSkip?.addEventListener('click', () => { if (!MG.active) return; MG.idx++; mgRenderStatus(); mgRenderQuestion(); });

  // --- Socket lifecycle ---
  socket.on('connect', () => {
    state.youId = socket.id;

    if (rules.mode === 'solo') {
      setSearching(true, 'Starting solo game…');
      socket.emit('solo:start', { perTurn: rules.perTurn, topicKey, name });
    } else if (rules.mode === 'pvp') {
      setSearching(true, `Finding ${rules.opponents} opponent${rules.opponents > 1 ? 's' : ''} in ${topicLbl}…`);
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

  socket.on('match:searching', ({ size, perTurn, topicLabel }) => {
    setSearching(true, `Searching for a ${size}-player match in ${topicLabel}… ${perTurn}s/turn`);
  });
  socket.on('match:found', ({ roomCode }) => { roomCodeLabel.textContent = roomCode || '—'; });
  socket.on('match:cancelled', () => { setSearching(false, ''); });

  socket.on('room:created', ({ roomCode }) => { state.roomCode = roomCode; roomCodeLabel.textContent = roomCode; });

  socket.on('room:update', (payload) => {
    state.roomCode        = payload.roomCode;
    state.hostId          = payload.hostId;
    state.phase           = payload.phase;
    state.perTurn         = payload.perTurn;
    state.topicKey        = payload.topicKey || topicKey;
    state.topicLabel      = payload.topicLabel || topicLbl;
    state.mode            = payload.mode || rules.mode;
    state.players         = payload.players || [];
    state.currentPlayerId = payload.currentPlayerId;
    state.used            = payload.used || [];

    topicLabel.textContent   = state.topicLabel;
    perTurnLabel.textContent = state.perTurn;

    roomCodeLabel.textContent = state.roomCode || '—';
    roomCodeWrap.classList.toggle('hidden', !(state.mode !== 'solo' && state.roomCode));

    const iAmHost = state.youId && state.hostId === state.youId;
    const youRow = (state.players || []).find(p => p.id === state.youId);

    // Spectator mode
    const newIsSpectator = (state.phase === 'playing') && youRow && !youRow.alive;
    state.isSpectator = newIsSpectator;
    showSpectatorBanner(state.isSpectator);

    // Host tools (private lobby only)
    hostPanel.classList.toggle('hidden', !(state.mode !== 'solo' && state.phase === 'lobby' && iAmHost));
    if (iAmHost && hostTopic)    hostTopic.value    = state.topicKey;
    if (iAmHost && perTurnInput) perTurnInput.value = state.perTurn || rules.perTurn;
    if (youRow && playerNameEl) playerNameEl.textContent = youRow.name;

    const yourTurn = state.phase === 'playing' && state.currentPlayerId === state.youId && youRow && youRow.alive;
    answerInput.disabled = !yourTurn;
    btnSubmit.disabled   = !yourTurn;
    answerInput.placeholder = state.isSpectator
      ? 'You are eliminated — spectating…'
      : (yourTurn ? 'Type an answer…' : (state.phase === 'playing' ? 'Wait for your turn…' : 'Game not started'));

    const cur = state.players.find(p => p.id === state.currentPlayerId);
    currentName.textContent = cur ? cur.name : '—';

    setSearching(false, '');
    renderPlayers();
    renderUsed();

    // Enforce the ">=3 players" rule dynamically
    if (!canOfferMiniGame()) { if (MG.active) { MG.reset(); showMini(false); } }
  });

  // Turn cycle
  socket.on('turn:start', ({ currentPlayerId, remaining }) => {
    state.currentPlayerId = currentPlayerId;
    timerEl.textContent = remaining + 's';
    answerHint.textContent = '';
    const youRow = (state.players || []).find(p => p.id === state.youId);
    const cur = state.players.find(p => p.id === currentPlayerId);
    currentName.textContent = cur ? cur.name : '—';
    const yourTurn = currentPlayerId === state.youId && youRow && youRow.alive;
    answerInput.disabled = !yourTurn || state.isSpectator;
    btnSubmit.disabled   = !yourTurn || state.isSpectator;
    answerInput.placeholder = state.isSpectator
      ? 'You are eliminated — spectating…'
      : (yourTurn ? 'Type an answer…' : 'Wait for your turn…');
    primeAnswerInput(); // re-prime input each turn
    renderPlayers();
  });

  socket.on('turn:tick', ({ remaining }) => { timerEl.textContent = Math.max(0, remaining) + 's'; });

  socket.on('turn:timeout', ({ playerId }) => {
    timerEl.textContent = '0s';
    if (playerId === state.youId) {
      answerInput.disabled = true; btnSubmit.disabled = true;
      answerInput.placeholder = 'You are eliminated — spectating…';
      showSpectatorBanner(true);
    }
  });

  // Answers UX
  socket.on('answer:accepted', ({ value }) => { answerHint.textContent = ''; });
  socket.on('answer:rejected', ({ reason, country, min, elapsed }) => {
    if (reason === 'invalid')        answerHint.textContent = 'Not recognized. Try another.';
    else if (reason === 'repeated')  answerHint.textContent = `"${country}" already used.`;
    else if (reason === 'toosoon')   answerHint.textContent = `Submitted too fast. Please type your answer (≥ ${min || 150}ms).`;
    else                             answerHint.textContent = 'Rejected. Try again.';
  });

  // Main game ends → stop mini-game & show results
  function stopMiniIfActive() { if (MG.active) { MG.reset(); showMini(false); } }

  // PvP: win/loss
  socket.on('game:over', ({ winnerId, players }) => {
    stopMiniIfActive();
    const youWon = winnerId && winnerId === state.youId;
    resultTitle.textContent = youWon ? '🏆 You won!' : 'You lost';
    scoreboard.innerHTML = '<h3>Scoreboard</h3>';
    const ul = document.createElement('ul'); ul.className = 'board';
    players.slice().sort((a,b)=>b.score-a.score).forEach((p,i) => {
      const li = document.createElement('li');
      li.textContent = `${i+1}. ${p.name} — ${p.score}`;
      if (winnerId && p.id === winnerId) li.classList.add('winner');
      ul.appendChild(li);
    });
    scoreboard.appendChild(ul);
    showOverlay(true);

    const me = players.find(p => p.id === state.youId);
    if (me) recordScore({ mode: 'pvp', topicKey: state.topicKey, score: me.score, outcome: youWon ? 'win' : 'loss' });
  });

  // PvP: draw
  socket.on('game:draw', ({ players }) => {
    stopMiniIfActive();
    resultTitle.textContent = 'Draw';
    scoreboard.innerHTML = '<h3>Scoreboard</h3>';
    const ul = document.createElement('ul'); ul.className = 'board';
    players.slice().sort((a,b)=>b.score-a.score).forEach((p,i) => {
      const li = document.createElement('li'); li.textContent = `${i+1}. ${p.name} — ${p.score}`; ul.appendChild(li);
    });
    scoreboard.appendChild(ul);
    showOverlay(true);

    const me = players.find(p => p.id === state.youId);
    if (me) recordScore({ mode: 'pvp', topicKey: state.topicKey, score: me.score, outcome: 'draw' });
  });

  // Solo end
  socket.on('solo:over', ({ reason, topicLabel, usedCount, total, players }) => {
    stopMiniIfActive();
    const p = players && players[0] ? players[0] : { name: 'You', score: usedCount || 0 };
    resultTitle.textContent = reason === 'completed' ? '🎉 Completed the list!' : 'Game Over';
    scoreboard.innerHTML = '';
    const info = document.createElement('div');
    info.innerHTML =
      `<p><strong>${p.name}</strong> — Score: <strong>${p.score}</strong></p>` +
      (total ? `<p>${topicLabel}: ${usedCount} / ${total} correct</p>` : `<p>${topicLabel}: ${usedCount} correct</p>`);
    scoreboard.appendChild(info);
    showOverlay(true);

    recordScore({ mode: 'solo', topicKey: state.topicKey, score: p.score, outcome: (reason === 'completed') ? 'completed' : 'timeout' });
  });

  // Best-effort leave on navigation
  window.addEventListener('pagehide', () => { try { socket.emit('room:leave'); } catch {} });
})();
