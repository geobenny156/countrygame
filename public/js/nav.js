// NG = helper namespace for navigation + stored settings
window.NG = (function () {
  const kName = 'ng_name';
  const kTopicKey = 'ng_topic_key';
  const kTopicLabel = 'ng_topic_label';
  const kMode = 'ng_mode';
  const kPerTurn = 'ng_perturn';
  const kOpp = 'ng_opponents';
  const kRoomAction = 'ng_room_action'; // 'create' | 'join' | ''
  const kRoomCode = 'ng_room_code';

  // Name is session-only (clear on tab close). Also clear any old localStorage name.
  try { localStorage.removeItem(kName); } catch {}
  function setName(name) { sessionStorage.setItem(kName, name); }
  function getName() { return sessionStorage.getItem(kName) || ''; }

  function setTopic(key, label) { localStorage.setItem(kTopicKey, key); localStorage.setItem(kTopicLabel, label); }
  function getTopicKey() { return localStorage.getItem(kTopicKey) || 'countries'; }
  function getTopicLabel() { return localStorage.getItem(kTopicLabel) || 'Countries'; }

  function setRules({ mode, perTurn, opponents, roomAction, roomCode }) {
    localStorage.setItem(kMode, mode || 'pvp');
    localStorage.setItem(kPerTurn, String(perTurn || 15));
    localStorage.setItem(kOpp, String(opponents || 3));
    localStorage.setItem(kRoomAction, roomAction || '');
    localStorage.setItem(kRoomCode, roomCode || '');
  }
  function getRules() {
    return {
      mode: localStorage.getItem(kMode) || 'pvp',
      perTurn: Number(localStorage.getItem(kPerTurn) || 15),
      opponents: Number(localStorage.getItem(kOpp) || 3),
      roomAction: localStorage.getItem(kRoomAction) || '',
      roomCode: localStorage.getItem(kRoomCode) || ''
    };
  }

  function requireNameOrRedirect(url) { if (!getName()) location.href = url; }
  function requireTopicOrRedirect(url) { if (!getTopicKey()) location.href = url; }

  return {
    setName, getName,
    setTopic, getTopicKey, getTopicLabel,
    setRules, getRules,
    requireNameOrRedirect, requireTopicOrRedirect
  };
})();
