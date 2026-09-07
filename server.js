const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const sqlite3 = require('sqlite3').verbose();
const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const frontendUrl = process.env.FRONTEND_URL || '';
const io = new Server(server, { cors: { origin: frontendUrl || true, credentials: true } });
const databasePath = path.join(__dirname, '..', 'database', 'database.sqlite');
const database = process.env.MONGODB_URI ? null : new sqlite3.Database(databasePath);
const mongoClient = process.env.MONGODB_URI ? new MongoClient(process.env.MONGODB_URI) : null;
let mongoDatabase = null;
const sockets = new Map();
const roomMembers = new Map();
const liveStreams = new Map();
const liveMembers = new Map();
const liveChats = new Map();
const profileAvatars = ['🦊', '🌙', '🪶', '🌿', '✦', '🌲', '🌊', '☀️'];

app.use((request, response, next) => {
  if (frontendUrl) {
    response.setHeader('Access-Control-Allow-Origin', frontendUrl);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  }
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_request, response) => response.json({ ok: true }));

function run(sql, params = []) {
  if (mongoDatabase) return mongoRun(sql, params);
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function all(sql, params = []) {
  if (mongoDatabase) return mongoAll(sql, params);
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

function one(sql, params = []) {
  if (mongoDatabase) return mongoOne(sql, params);
  return new Promise((resolve, reject) => {
    database.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
}

function mongoCollection(name) {
  return mongoDatabase.collection(name);
}

function mongoUserProjection(user) {
  if (!user) return undefined;
  const { _id, ...publicDocument } = user;
  return publicDocument;
}

async function mongoRun(sql, params) {
  if (sql.includes('INSERT OR REPLACE INTO guests')) {
    await mongoCollection('guests').updateOne({ id: params[0] }, { $set: { id: params[0], username: params[1], avatar: params[2], created_at: params[3] } }, { upsert: true });
  } else if (sql.includes('INSERT INTO users')) {
    await mongoCollection('users').insertOne({ id: params[0], username: params[1], email: params[2], password_hash: params[3], avatar: params[4], bio: params[5], created_at: params[6] });
  } else if (sql.includes('INSERT INTO sessions')) {
    await mongoCollection('sessions').insertOne({ token_hash: params[0], user_id: params[1], expires_at: params[2] });
  } else if (sql.includes('DELETE FROM sessions')) {
    await mongoCollection('sessions').deleteOne({ token_hash: params[0] });
  } else if (sql.includes('INSERT INTO rooms')) {
    await mongoCollection('rooms').insertOne({ code: params[0], name: params[1], owner_id: params[2], created_at: params[3] });
  } else if (sql.includes('INSERT INTO messages')) {
    const id = Date.now();
    await mongoCollection('messages').insertOne({ id, room_code: params[0], user_id: params[1], username: params[2], avatar: params[3], text: params[4], reply_to_id: params[5], reply_text: params[6], created_at: params[7], edited_at: null, deleted_at: null });
    return { lastID: id };
  } else if (sql.includes('UPDATE users SET')) {
    await mongoCollection('users').updateOne({ id: params[3] }, { $set: { username: params[0], bio: params[1], avatar: params[2] } });
  } else if (sql.includes('UPDATE messages SET text = ?, edited_at')) {
    await mongoCollection('messages').updateOne({ id: params[2] }, { $set: { text: params[0], edited_at: params[1] } });
  } else if (sql.includes('UPDATE messages SET text = ?, deleted_at')) {
    await mongoCollection('messages').updateOne({ id: params[2] }, { $set: { text: params[0], deleted_at: params[1] } });
  } else if (sql.includes('DELETE FROM message_reactions')) {
    await mongoCollection('message_reactions').deleteOne({ message_id: params[0], user_id: params[1] });
  } else if (sql.includes('INSERT OR REPLACE INTO message_reactions')) {
    await mongoCollection('message_reactions').updateOne({ message_id: params[0], user_id: params[1] }, { $set: { message_id: params[0], user_id: params[1], emoji: params[2], created_at: params[3] } }, { upsert: true });
  } else if (sql.includes('INSERT OR REPLACE INTO message_reads')) {
    await mongoCollection('message_reads').updateOne({ message_id: params[0], user_id: params[1] }, { $set: { message_id: params[0], user_id: params[1], read_at: params[2] } }, { upsert: true });
  }
  return {};
}

async function mongoAll(sql, params) {
  let documents = [];
  if (sql.includes('SELECT code FROM rooms')) documents = await mongoCollection('rooms').find({ code: params[0] }).toArray();
  else if (sql.includes('SELECT id FROM users WHERE username = ? AND id !=')) documents = await mongoCollection('users').find({ username: params[0], id: { $ne: params[1] } }).toArray();
  else if (sql.includes('SELECT id FROM users WHERE username')) documents = await mongoCollection('users').find({ $or: [{ username: params[0] }, { email: params[1] }] }).toArray();
  else if (sql.includes('FROM messages WHERE room_code')) {
    documents = await mongoCollection('messages').find({ room_code: params[0] }).sort({ id: -1 }).limit(100).toArray();
    documents = documents.map(mongoMessageRow).reverse();
  } else if (sql.includes('FROM message_reactions')) documents = (await mongoCollection('message_reactions').find({ message_id: params[0] }).project({ _id: 0, user_id: 1, emoji: 1 }).toArray()).map((reaction) => ({ userId: reaction.user_id, emoji: reaction.emoji }));
  return documents;
}

async function mongoOne(sql, params) {
  let document;
  if (sql.includes('FROM sessions JOIN users')) {
    const session = await mongoCollection('sessions').findOne({ token_hash: params[0], expires_at: { $gt: params[1] } });
    document = session ? await mongoCollection('users').findOne({ id: session.user_id }) : null;
  } else if (sql.includes('SELECT * FROM users WHERE email')) document = await mongoCollection('users').findOne({ email: params[0] });
  else if (sql.includes('SELECT id, username, email, avatar, bio, created_at FROM users')) document = await mongoCollection('users').findOne({ id: params[0] });
  else if (sql.includes('FROM messages WHERE id = ? AND user_id')) document = await mongoCollection('messages').findOne({ id: params[0], user_id: params[1], deleted_at: null }, { projection: { id: 1, room_code: 1 } });
  else if (sql.includes('FROM messages WHERE id = ?')) document = await mongoCollection('messages').findOne({ id: params[0], deleted_at: null }, { projection: { id: 1, room_code: 1 } });
  else if (sql.includes('FROM message_reactions')) document = await mongoCollection('message_reactions').findOne({ message_id: params[0], user_id: params[1] });
  if (!document) return null;
  if (document.room_code) document.roomCode = document.room_code;
  return mongoUserProjection(document);
}

function mongoMessageRow(message) {
  return { id: message.id, userId: message.user_id, username: message.username, avatar: message.avatar, text: message.text, createdAt: message.created_at, replyToId: message.reply_to_id, replyText: message.reply_text, editedAt: message.edited_at, deletedAt: message.deleted_at };
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }));
}

function sessionCookie(token) {
  const crossSite = process.env.NODE_ENV === 'production' ? 'SameSite=None; Secure' : 'SameSite=Lax';
  return `orbit_session=${encodeURIComponent(token)}; HttpOnly; ${crossSite}; Path=/; Max-Age=2592000`;
}

function clearSessionCookie() {
  const crossSite = process.env.NODE_ENV === 'production' ? 'SameSite=None; Secure' : 'SameSite=Lax';
  return `orbit_session=; HttpOnly; ${crossSite}; Path=/; Max-Age=0`;
}

function publicUser(user) {
  return { id: user.id, username: user.username, email: user.email, avatar: user.avatar, bio: user.bio, joinedAt: user.created_at };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scrypt(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedPassword) {
  const [salt, key] = storedPassword.split(':');
  const derivedKey = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), derivedKey);
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [tokenHash, userId, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()]);
  return token;
}

async function authenticatedUser(request) {
  const token = parseCookies(request).orbit_session;
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return one(`SELECT users.id, users.username, users.email, users.avatar, users.bio, users.created_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`, [tokenHash, new Date().toISOString()]);
}

function validUsername(username) {
  return typeof username === 'string' && /^[a-zA-Z0-9_]{3,24}$/.test(username);
}

app.post('/api/auth/register', async (request, response) => {
  try {
    const { username, email, password } = request.body || {};
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!validUsername(username) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || typeof password !== 'string' || password.length < 8) {
      return response.status(400).json({ error: 'Use a username (3-24 letters, numbers, or underscores), valid email, and password of at least 8 characters.' });
    }
    if (await one('SELECT id FROM users WHERE username = ? OR email = ?', [username, normalizedEmail])) return response.status(409).json({ error: 'That username or email is already in use.' });
    const user = { id: `user-${crypto.randomUUID()}`, username, email: normalizedEmail, avatar: avatarsForUser(username), bio: '', passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
    await run('INSERT INTO users (id, username, email, password_hash, avatar, bio, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [user.id, user.username, user.email, user.passwordHash, user.avatar, user.bio, user.createdAt]);
    const token = await createSession(user.id);
    response.setHeader('Set-Cookie', sessionCookie(token));
    return response.status(201).json({ user: publicUser({ ...user, created_at: user.createdAt }) });
  } catch (error) {
    return response.status(500).json({ error: 'Could not create the account.' });
  }
});

app.post('/api/auth/login', async (request, response) => {
  try {
    const { email, password } = request.body || {};
    const user = await one('SELECT * FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
    if (!user || typeof password !== 'string' || !(await verifyPassword(password, user.password_hash))) return response.status(401).json({ error: 'Email or password is incorrect.' });
    const token = await createSession(user.id);
    response.setHeader('Set-Cookie', sessionCookie(token));
    return response.json({ user: publicUser(user) });
  } catch (error) {
    return response.status(500).json({ error: 'Could not log in.' });
  }
});

app.post('/api/auth/logout', async (request, response) => {
  const token = parseCookies(request).orbit_session;
  if (token) await run('DELETE FROM sessions WHERE token_hash = ?', [crypto.createHash('sha256').update(token).digest('hex')]);
  response.setHeader('Set-Cookie', clearSessionCookie());
  response.json({ ok: true });
});

app.get('/api/auth/me', async (request, response) => {
  const user = await authenticatedUser(request);
  response.json({ user: user ? publicUser(user) : null });
});

app.put('/api/profile', async (request, response) => {
  const user = await authenticatedUser(request);
  if (!user) return response.status(401).json({ error: 'Log in to edit your profile.' });
  const { username, bio, avatar } = request.body || {};
  if (!validUsername(username) || typeof bio !== 'string' || bio.length > 160 || typeof avatar !== 'string' || avatar.length > 8) return response.status(400).json({ error: 'Profile details are invalid.' });
  const duplicate = await one('SELECT id FROM users WHERE username = ? AND id != ?', [username, user.id]);
  if (duplicate) return response.status(409).json({ error: 'That username is already in use.' });
  await run('UPDATE users SET username = ?, bio = ?, avatar = ? WHERE id = ?', [username, bio.trim(), avatar, user.id]);
  const updated = await one('SELECT id, username, email, avatar, bio, created_at FROM users WHERE id = ?', [user.id]);
  response.json({ user: publicUser(updated) });
});

function makeCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function avatarsForUser(username) {
  return profileAvatars[username.length % profileAvatars.length];
}

function roomUsers(roomCode) {
  return [...(roomMembers.get(roomCode) || [])]
    .map((socketId) => sockets.get(socketId))
    .filter(Boolean)
    .map(({ socketId, id, username, avatar }) => ({ socketId, id, username, avatar }));
}

async function initializeDatabase() {
  if (mongoClient) {
    await mongoClient.connect();
    mongoDatabase = mongoClient.db(process.env.MONGODB_DB || 'orbit');
    await Promise.all([
      mongoCollection('users').createIndex({ username: 1 }, { unique: true }),
      mongoCollection('users').createIndex({ email: 1 }, { unique: true }),
      mongoCollection('sessions').createIndex({ token_hash: 1 }, { unique: true }),
      mongoCollection('rooms').createIndex({ code: 1 }, { unique: true }),
      mongoCollection('messages').createIndex({ room_code: 1, id: -1 }),
      mongoCollection('message_reactions').createIndex({ message_id: 1, user_id: 1 }, { unique: true }),
      mongoCollection('message_reads').createIndex({ message_id: 1, user_id: 1 }, { unique: true })
    ]);
    console.log(`Using MongoDB database: ${process.env.MONGODB_DB || 'orbit'}`);
    return;
  }
  console.log('Initializing local SQLite database...');
  await run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS guests (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    avatar TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await ensureColumn('messages', 'reply_to_id', 'INTEGER');
  await ensureColumn('messages', 'reply_text', 'TEXT');
  await ensureColumn('messages', 'edited_at', 'TEXT');
  await ensureColumn('messages', 'deleted_at', 'TEXT');
  await run(`CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS message_reads (
    message_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  )`);
  console.log('Local SQLite database ready.');
}

async function ensureColumn(table, column, definition) {
  const columns = await all(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function messageReactions(messageId) {
  return all('SELECT user_id AS userId, emoji FROM message_reactions WHERE message_id = ?', [messageId]);
}

io.on('connection', (socket) => {
  socket.on('guest:join', async (guest, callback) => {
    if (!guest?.id || !guest.username || !guest.avatar) return callback?.({ error: 'Guest details are required.' });
    sockets.set(socket.id, { socketId: socket.id, id: guest.id, username: guest.username, avatar: guest.avatar, roomCode: null });
    await run('INSERT OR REPLACE INTO guests (id, username, avatar, created_at) VALUES (?, ?, ?, ?)', [guest.id, guest.username, guest.avatar, new Date().toISOString()]);
    callback?.({ ok: true });
    io.emit('presence:update', { online: sockets.size });
  });

  socket.on('room:create', async ({ name }, callback) => {
    const user = sockets.get(socket.id);
    if (!user || !name?.trim()) return callback?.({ error: 'A room name is required.' });
    let code = makeCode();
    while ((await all('SELECT code FROM rooms WHERE code = ?', [code])).length) code = makeCode();
    await run('INSERT INTO rooms (code, name, owner_id, created_at) VALUES (?, ?, ?, ?)', [code, name.trim().slice(0, 60), user.id, new Date().toISOString()]);
    joinRoom(socket, code);
    callback?.({ ok: true, room: { code, name: name.trim().slice(0, 60) } });
  });

  socket.on('room:join', async ({ code }, callback) => {
    const user = sockets.get(socket.id);
    const normalizedCode = code?.trim().toUpperCase();
    if (!user || !normalizedCode) return callback?.({ error: 'Enter a room code.' });
    const rooms = await all('SELECT code, name FROM rooms WHERE code = ?', [normalizedCode]);
    if (!rooms.length) return callback?.({ error: 'That room does not exist.' });
    joinRoom(socket, normalizedCode);
    const messages = await all(`SELECT id, user_id AS userId, username, avatar, text, created_at AS createdAt,
      reply_to_id AS replyToId, reply_text AS replyText, edited_at AS editedAt, deleted_at AS deletedAt
      FROM messages WHERE room_code = ? ORDER BY id DESC LIMIT 100`, [normalizedCode]);
    for (const message of messages) message.reactions = await messageReactions(message.id);
    callback?.({ ok: true, room: rooms[0], messages: messages.reverse() });
  });

  socket.on('room:leave', () => leaveRoom(socket));

  socket.on('message:send', async ({ text, replyToId, replyText }, callback) => {
    const user = sockets.get(socket.id);
    if (!user?.roomCode || !text?.trim()) return callback?.({ error: 'Join a room before sending messages.' });
    const message = { userId: user.id, username: user.username, avatar: user.avatar, text: text.trim().slice(0, 2000), replyToId: Number.isInteger(replyToId) ? replyToId : null, replyText: typeof replyText === 'string' ? replyText.slice(0, 240) : null, createdAt: new Date().toISOString(), status: 'delivered', reactions: [] };
    const result = await run('INSERT INTO messages (room_code, user_id, username, avatar, text, reply_to_id, reply_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [user.roomCode, message.userId, message.username, message.avatar, message.text, message.replyToId, message.replyText, message.createdAt]);
    message.id = result.lastID;
    io.to(user.roomCode).emit('message:new', message);
    callback?.({ ok: true });
  });

  socket.on('message:edit', async ({ id, text }, callback) => {
    const user = sockets.get(socket.id);
    const message = await one('SELECT id, room_code AS roomCode FROM messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [id, user?.id]);
    if (!user?.roomCode || !message || message.roomCode !== user.roomCode || !text?.trim()) return callback?.({ error: 'You can only edit your own message in this room.' });
    const editedAt = new Date().toISOString();
    await run('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?', [text.trim().slice(0, 2000), editedAt, id]);
    io.to(user.roomCode).emit('message:updated', { id, text: text.trim().slice(0, 2000), editedAt });
    callback?.({ ok: true });
  });

  socket.on('message:delete', async ({ id }, callback) => {
    const user = sockets.get(socket.id);
    const message = await one('SELECT id, room_code AS roomCode FROM messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [id, user?.id]);
    if (!user?.roomCode || !message || message.roomCode !== user.roomCode) return callback?.({ error: 'You can only delete your own message in this room.' });
    const deletedAt = new Date().toISOString();
    await run('UPDATE messages SET text = ?, deleted_at = ? WHERE id = ?', ['This message was deleted.', deletedAt, id]);
    io.to(user.roomCode).emit('message:updated', { id, text: 'This message was deleted.', deletedAt });
    callback?.({ ok: true });
  });

  socket.on('message:react', async ({ id, emoji }, callback) => {
    const user = sockets.get(socket.id);
    const message = await one('SELECT id, room_code AS roomCode FROM messages WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!user?.roomCode || !message || message.roomCode !== user.roomCode || typeof emoji !== 'string' || emoji.length > 8) return callback?.({ error: 'Reaction could not be added.' });
    const existing = await one('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?', [id, user.id]);
    if (existing?.emoji === emoji) await run('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?', [id, user.id]);
    else await run('INSERT OR REPLACE INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', [id, user.id, emoji, new Date().toISOString()]);
    io.to(user.roomCode).emit('message:reactions', { id, reactions: await messageReactions(id) });
    callback?.({ ok: true });
  });

  socket.on('message:read', async ({ ids }) => {
    const user = sockets.get(socket.id);
    const messageIds = Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id)).slice(0, 100) : [];
    if (!user?.roomCode || !messageIds.length) return;
    for (const id of messageIds) await run('INSERT OR REPLACE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)', [id, user.id, new Date().toISOString()]);
    socket.to(user.roomCode).emit('message:read', { ids: messageIds, userId: user.id });
  });

  socket.on('typing:set', ({ isTyping }) => {
    const user = sockets.get(socket.id);
    if (user?.roomCode) socket.to(user.roomCode).emit('typing:update', { username: user.username, isTyping: Boolean(isTyping) });
  });

  socket.on('signal', ({ target, data }) => {
    if (target && sockets.has(target)) io.to(target).emit('signal', { from: socket.id, data });
  });

  socket.on('live:start', ({ title }, callback) => {
    const user = sockets.get(socket.id);
    if (!user) return callback?.({ error: 'Join as a guest first.' });
    const stream = { id: socket.id, hostId: socket.id, hostName: user.username, hostAvatar: user.avatar, title: (title || 'Untitled live room').trim().slice(0, 80), viewerCount: 0 };
    liveStreams.set(socket.id, stream);
    liveMembers.set(socket.id, new Set([socket.id]));
    liveChats.set(socket.id, []);
    socket.data.liveHostId = socket.id;
    socket.join(`live:${socket.id}`);
    socket.broadcast.emit('live:available', stream);
    callback?.({ ok: true, stream });
  });

  socket.on('live:list', (callback) => callback?.([...liveStreams.values()].map(publicLiveStream)));

  socket.on('live:join', ({ hostId }, callback) => {
    const user = sockets.get(socket.id);
    const stream = liveStreams.get(hostId);
    if (!user || !stream) return callback?.({ error: 'This live room is no longer available.' });
    leaveLive(socket, false);
    socket.join(`live:${hostId}`);
    if (!liveMembers.has(hostId)) liveMembers.set(hostId, new Set());
    liveMembers.get(hostId).add(socket.id);
    socket.data.liveHostId = hostId;
    stream.viewerCount = Math.max(0, liveMembers.get(hostId).size - 1);
    io.to(`live:${hostId}`).emit('live:audience', { hostId, viewerCount: stream.viewerCount });
    callback?.({ ok: true, stream: publicLiveStream(stream), messages: liveChats.get(hostId) || [] });
  });

  socket.on('live:leave', () => leaveLive(socket, true));

  socket.on('live:message', ({ hostId, text }, callback) => {
    const user = sockets.get(socket.id);
    const members = liveMembers.get(hostId);
    if (!user || !members?.has(socket.id) || !text?.trim()) return callback?.({ error: 'Join a live room before chatting.' });
    const message = { id: `${Date.now()}-${socket.id}`, userId: user.id, username: user.username, avatar: user.avatar, text: text.trim().slice(0, 500), createdAt: new Date().toISOString() };
    const history = liveChats.get(hostId) || [];
    history.push(message);
    liveChats.set(hostId, history.slice(-100));
    io.to(`live:${hostId}`).emit('live:message', message);
    callback?.({ ok: true });
  });

  socket.on('live:stop', (_payload, callback) => {
    stopLive(socket.id);
    callback?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const user = sockets.get(socket.id);
    if (user) leaveRoom(socket);
    stopLive(socket.id);
    leaveLive(socket, false);
    sockets.delete(socket.id);
    io.emit('presence:update', { online: sockets.size });
  });
});

function publicLiveStream(stream) {
  return { id: stream.id, hostId: stream.hostId, hostName: stream.hostName, hostAvatar: stream.hostAvatar, title: stream.title, viewerCount: stream.viewerCount || 0 };
}

function leaveLive(socket, notify) {
  const hostId = socket.data.liveHostId;
  if (!hostId) return;
  liveMembers.get(hostId)?.delete(socket.id);
  socket.leave(`live:${hostId}`);
  socket.data.liveHostId = null;
  const stream = liveStreams.get(hostId);
  if (stream) {
    stream.viewerCount = Math.max(0, (liveMembers.get(hostId)?.size || 1) - 1);
    if (notify) io.to(`live:${hostId}`).emit('live:audience', { hostId, viewerCount: stream.viewerCount });
  }
}

function stopLive(hostId) {
  if (!liveStreams.delete(hostId)) return;
  for (const socketId of liveMembers.get(hostId) || []) {
    const member = io.sockets.sockets.get(socketId);
    member?.leave(`live:${hostId}`);
    if (member) member.data.liveHostId = null;
  }
  liveMembers.delete(hostId);
  liveChats.delete(hostId);
  io.emit('live:ended', { hostId });
}

function joinRoom(socket, code) {
  const user = sockets.get(socket.id);
  if (!user) return;
  if (user.roomCode && user.roomCode !== code) leaveRoom(socket);
  socket.join(code);
  user.roomCode = code;
  if (!roomMembers.has(code)) roomMembers.set(code, new Set());
  roomMembers.get(code).add(socket.id);
  io.to(code).emit('room:members', roomUsers(code));
}

function leaveRoom(socket) {
  const user = sockets.get(socket.id);
  if (!user?.roomCode) return;
  const code = user.roomCode;
  socket.leave(code);
  roomMembers.get(code)?.delete(socket.id);
  if (!roomMembers.get(code)?.size) roomMembers.delete(code);
  user.roomCode = null;
  io.to(code).emit('room:members', roomUsers(code));
}

initializeDatabase().then(() => {
  server.listen(PORT, () => console.log(`Orbit is running at http://localhost:${PORT}`));
}).catch((error) => {
  console.error('Could not initialize database:', error);
  process.exit(1);
});
