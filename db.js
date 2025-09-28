// Simple JSON-backed datastore for Naming Game
const fs = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

function ensureStore() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  if (!fs.existsSync(DATA_FILE)) {
    const empty = { users: [], scores: [], customTopics: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(empty, null, 2), 'utf8');
  }
}
ensureStore();

function load() {
  try {
    let txt = fs.readFileSync(DATA_FILE, 'utf8');
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
    const j = JSON.parse(txt || '{}');
    return {
      users: Array.isArray(j.users) ? j.users : [],
      scores: Array.isArray(j.scores) ? j.scores : [],
      customTopics: Array.isArray(j.customTopics) ? j.customTopics : []
    };
  } catch {
    return { users: [], scores: [], customTopics: [] };
  }
}
let DB = load();

function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(DB, null, 2)); } catch (e) { console.warn('[db] save failed:', e.message); }
}
function uid(prefix='id'){ try { return `${prefix}_${require('crypto').randomUUID().slice(0,8)}`; } catch { return `${prefix}_${Math.random().toString(36).slice(2,10)}`; } }

// ---- Users ----
function createUser(u) { DB.users.push(u); save(); return u; }
function findUserByEmail(email) { const e = String(email||'').trim().toLowerCase(); return DB.users.find(u => u.email === e) || null; }
function findUserById(id) { return DB.users.find(u => u.id === id) || null; }

function updateUserDisplayName(userId, displayName) {
  const u = findUserById(userId); if (!u) return false;
  u.displayName = displayName; save(); return true;
}
function updateUserEmail(userId, newEmail) {
  const e = String(newEmail||'').trim().toLowerCase();
  if (!e) return false;
  if (DB.users.some(u => u.email === e && u.id !== userId)) return false; // uniqueness
  const u = findUserById(userId); if (!u) return false;
  u.email = e; save(); return true;
}
function updateUserPassword(userId, newPassHash) {
  const u = findUserById(userId); if (!u) return false;
  u.passHash = newPassHash; save(); return true;
}

function deleteUserAndData(userId) {
  // remove scores
  const scoresBefore = DB.scores.length;
  DB.scores = DB.scores.filter(s => s.userId !== userId);
  const scoresRemoved = scoresBefore - DB.scores.length;

  // remove custom topics created by this user
  const topicsBefore = DB.customTopics.length;
  DB.customTopics = DB.customTopics.filter(t => t.createdBy !== userId);
  const topicsRemoved = topicsBefore - DB.customTopics.length;

  // remove user
  const usersBefore = DB.users.length;
  DB.users = DB.users.filter(u => u.id !== userId);
  const usersRemoved = usersBefore - DB.users.length;

  save();
  return { usersRemoved, scoresRemoved, topicsRemoved };
}

// ---- Scores ----
function addScore(s) { DB.scores.push(s); save(); return s; }
function scoresByUser(userId, limit=100) {
  return DB.scores.filter(s => s.userId === userId)
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, Math.max(1, Math.min(limit, 1000)));
}
function topByTopic(topicKey, mode='pvp', limit=10) {
  const arr = DB.scores.filter(s => s.topicKey === topicKey && s.mode === mode);
  // Take best per user (highest score)
  const bestByUser = new Map();
  for (const s of arr) {
    const prev = bestByUser.get(s.userId);
    if (!prev || s.score > prev.score) bestByUser.set(s.userId, s);
  }
  const top = Array.from(bestByUser.values())
    .sort((a,b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 50)));
  return top;
}

// ---- Custom Topics ----
function listCustomTopics() {
  return DB.customTopics.map(t => ({ key: t.key, label: t.label, count: (t.items||[]).length, createdAt: t.createdAt }));
}
function getCustomTopicByKey(key) { const k = String(key||'').trim(); return DB.customTopics.find(t => t.key === k) || null; }
function createCustomTopic({ label, items, createdBy=null }) {
  const key = uid('ct');
  const topic = {
    key, label: String(label||'').trim(),
    items: Array.isArray(items) ? items.slice(0,1000) : [],
    count: Array.isArray(items) ? items.length : 0,
    createdBy, createdAt: new Date().toISOString()
  };
  DB.customTopics.push(topic); save();
  return topic;
}

module.exports = {
  // users
  createUser, findUserByEmail, findUserById,
  updateUserDisplayName, updateUserEmail, updateUserPassword, deleteUserAndData,
  // scores
  addScore, scoresByUser, topByTopic,
  // custom topics
  listCustomTopics, getCustomTopicByKey, createCustomTopic,
  // util
  uid
};
