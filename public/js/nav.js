// NG: small navigation/storage helper used across pages
window.NG = (() => {
  const K_NAME   = 'ng:name';
  const K_TOPIC  = 'ng:topic';
  const K_TLABEL = 'ng:topicLabel';
  const K_RULES  = 'ng:rules';

  // --- Display name (guest or signed-in) ---
  function setName(name)  { localStorage.setItem(K_NAME, String(name || '').trim()); }
  function getName()      { return localStorage.getItem(K_NAME) || null; }
  function clearName()    { localStorage.removeItem(K_NAME); }

  // Redirect to the new account page if no name is set yet
  function requireNameOrRedirect(redirectTo = 'account.html') {
    const n = getName();
    if (!n) location.href = redirectTo;
  }

  // --- Topic selection ---
  function setTopic(key, label) {
    localStorage.setItem(K_TOPIC, String(key || '').trim());
    localStorage.setItem(K_TLABEL, String(label || key || '').trim());
  }
  function getTopicKey()   { return localStorage.getItem(K_TOPIC) || null; }
  function getTopicLabel() { return localStorage.getItem(K_TLABEL) || null; }
  function clearTopic()    { localStorage.removeItem(K_TOPIC); localStorage.removeItem(K_TLABEL); }

  function requireTopicOrRedirect(redirectTo = 'topics.html') {
    if (!getTopicKey()) location.href = redirectTo;
  }

  // --- Rules (mode, perTurn, etc.) ---
  function setRules(obj)  { localStorage.setItem(K_RULES, JSON.stringify(obj || {})); }
  function getRules()     { try { return JSON.parse(localStorage.getItem(K_RULES) || '{}'); } catch { return {}; } }
  function clearRules()   { localStorage.removeItem(K_RULES); }

  return {
    setName, getName, clearName, requireNameOrRedirect,
    setTopic, getTopicKey, getTopicLabel, clearTopic, requireTopicOrRedirect,
    setRules, getRules, clearRules
  };
})();
