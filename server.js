const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { db, getSettings, setSettings } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_HOURS = 8;
// 6 digits means 1,000,000 possible PINs, so random guessing almost never hits one of 30 real PINs.
const PIN_LENGTH = Math.min(8, Math.max(4, Number(process.env.PIN_LENGTH) || 6));
// Only trust X-Forwarded-For when a known proxy (Render, Railway, nginx, etc.) is in front of the app.
// Otherwise anyone could fake their IP and get around the rate limits.
const TRUST_PROXY = process.env.TRUST_PROXY || '';
const IS_PROD = process.env.NODE_ENV === 'production';
// Stops a double tap from clocking a student straight back out.
const MIN_PUNCH_GAP_MS = 60 * 1000;

// Refuse to start without a strong admin password.
if (ADMIN_PASSWORD.length < 12 || /^(changeme|password)/i.test(ADMIN_PASSWORD)) {
  console.error('ADMIN_PASSWORD must be set to at least 12 characters (a passphrase like "purple-tractor-lunch-49" works well).');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

// Security headers
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

// Block cross-site requests that try to change data (defense in depth on top of SameSite cookies).
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  // req.is() returns null when there is no body (e.g. logout) and false for a body that isn't JSON.
  if (req.is('application/json') === false) return res.status(415).json({ error: 'Expected JSON.' });
  next();
});

app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* ---------------- helpers ---------------- */

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// Wraps a handler so thrown HttpErrors become JSON responses.
const route = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (String(err.message).includes('UNIQUE constraint failed: students.pin')) {
      return res.status(409).json({ error: 'That PIN is already used by another student.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

function localDate(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(0, 10);
  }
}

function parseIso(value, field, { optional = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (optional) return null;
    throw new HttpError(400, `${field} is required.`);
  }
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new HttpError(400, `${field} is not a valid date/time.`);
  return new Date(t).toISOString();
}

function cleanName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) throw new HttpError(400, 'Name is required.');
  if (n.length > 80) throw new HttpError(400, 'Name is too long.');
  return n;
}

function cleanPin(pin) {
  const p = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(p)) throw new HttpError(400, 'PIN must be 4–8 digits.');
  return p;
}

function generatePin() {
  const taken = new Set(db.prepare('SELECT pin FROM students').all().map((r) => r.pin));
  for (let i = 0; i < 1000; i++) {
    const p = String(crypto.randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');
    // Skip easy-to-guess PINs like 0000 or 1234.
    if (/^(\d)\1+$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p)) continue;
    if (!taken.has(p)) return p;
  }
  throw new HttpError(500, 'Could not generate a unique PIN.');
}

/* --------- simple in-memory rate limiting for failed attempts --------- */

const failures = new Map(); // key -> { count, resetAt }
function isLimited(key, max) {
  const f = failures.get(key);
  if (!f || f.resetAt < Date.now()) return false;
  return f.count >= max;
}
function recordFailure(key, windowMs) {
  const now = Date.now();
  const f = failures.get(key);
  if (!f || f.resetAt < now) failures.set(key, { count: 1, resetAt: now + windowMs });
  else f.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, f] of failures) if (f.resetAt < now) failures.delete(k);
}, 10 * 60 * 1000).unref();

/* ---------------- admin sessions (random token, stored hashed in the database) ---------------- */

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PW_FP = sha256(`pw:${ADMIN_PASSWORD}`);

// Clear out expired sessions and any session from an old password.
db.prepare('DELETE FROM admin_sessions WHERE expires_at < ? OR pw_fp <> ?').run(Date.now(), PW_FP);

function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO admin_sessions (token_hash, pw_fp, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), PW_FP, Date.now() + SESSION_HOURS * 3600 * 1000);
  return token;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isAdmin(req) {
  const token = readCookie(req, 'admin_session');
  if (!token || token.length > 100) return false;
  const row = db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ? AND pw_fp = ?').get(sha256(token), PW_FP);
  return !!row && row.expires_at > Date.now();
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Not signed in.' });
}

function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ---------------- public (student) API ---------------- */

app.get('/api/config', route(() => {
  const s = getSettings();
  return { title: s.title };
}));

app.post('/api/punch', route((req) => {
  // Students share school Wi-Fi (one IP), so this limit is generous enough for typos
  // but still stops anyone from trying PINs one after another.
  const ipKey = `pin:${req.ip}`;
  if (isLimited(ipKey, 20)) throw new HttpError(429, 'Too many wrong PINs. Please wait 15 minutes and try again.');
  const pin = String(req.body.pin || '').trim();
  const student = /^\d{4,8}$/.test(pin)
    ? db.prepare('SELECT id, name FROM students WHERE pin = ? AND active = 1').get(pin)
    : null;
  if (!student) {
    recordFailure(ipKey, 15 * 60 * 1000);
    throw new HttpError(401, 'Wrong PIN.');
  }

  const s = getSettings();
  const now = new Date();
  const nowIso = now.toISOString();
  const open = db.prepare(
    'SELECT id, clock_in FROM entries WHERE student_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1'
  ).get(student.id);

  // Same day open entry: this punch is a clock out.
  if (open && localDate(open.clock_in, s.timezone) === localDate(nowIso, s.timezone)) {
    if (now - new Date(open.clock_in) < MIN_PUNCH_GAP_MS) {
      throw new HttpError(409, `${student.name}, you just clocked in. Wait a minute before clocking out.`);
    }
    db.prepare('UPDATE entries SET clock_out = ? WHERE id = ?').run(nowIso, open.id);
    const hours = (now - new Date(open.clock_in)) / 3600000;
    return { name: student.name, action: 'out', time: nowIso, clockIn: open.clock_in, hours };
  }

  // No open entry, or a forgotten clock out from an earlier day. That entry stays open and is
  // flagged in the admin report. This punch starts a new entry.
  db.prepare('INSERT INTO entries (student_id, clock_in) VALUES (?, ?)').run(student.id, nowIso);
  return { name: student.name, action: 'in', time: nowIso, missedClockOut: !!open };
}));

/* ---------------- admin auth ---------------- */

app.post('/api/admin/login', route((req, res) => {
  const key = `login:${req.ip}`;
  if (isLimited(key, 8)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  if (!passwordMatches(req.body.password)) {
    recordFailure(key, 15 * 60 * 1000);
    console.warn(`[security] Failed admin login from ${req.ip} at ${new Date().toISOString()}`);
    throw new HttpError(401, 'Incorrect password.');
  }
  failures.delete(key);
  console.log(`[security] Admin signed in from ${req.ip} at ${new Date().toISOString()}`);
  res.cookie('admin_session', createSession(), {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure || IS_PROD,
    maxAge: SESSION_HOURS * 3600 * 1000,
    path: '/',
  });
  return { ok: true };
}));

app.post('/api/admin/logout', route((req, res) => {
  const token = readCookie(req, 'admin_session');
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie('admin_session', { path: '/' });
  return { ok: true };
}));

// Ends every admin session, for example after using a shared or lost computer.
app.post('/api/admin/logout-all', requireAdmin, route((req, res) => {
  db.prepare('DELETE FROM admin_sessions').run();
  res.clearCookie('admin_session', { path: '/' });
  return { ok: true };
}));

app.get('/api/admin/me', route((req) => ({ signedIn: isAdmin(req) })));

app.use('/api/admin', requireAdmin);

/* ---------------- admin: students ---------------- */

app.get('/api/admin/students', route(() => {
  return db.prepare(`
    SELECT s.id, s.name, s.pin, s.active,
           (SELECT clock_in FROM entries e WHERE e.student_id = s.id AND e.clock_out IS NULL
             ORDER BY clock_in DESC LIMIT 1) AS open_since
    FROM students s
    ORDER BY s.active DESC, s.name COLLATE NOCASE
  `).all();
}));

app.post('/api/admin/students', route((req) => {
  const name = cleanName(req.body.name);
  const pin = req.body.pin ? cleanPin(req.body.pin) : generatePin();
  const r = db.prepare('INSERT INTO students (name, pin) VALUES (?, ?)').run(name, pin);
  return { id: Number(r.lastInsertRowid), name, pin, active: 1 };
}));

app.post('/api/admin/students/bulk', route((req) => {
  const names = (Array.isArray(req.body.names) ? req.body.names : [])
    .map((n) => String(n).trim()).filter(Boolean);
  if (!names.length) throw new HttpError(400, 'Add at least one name.');
  if (names.length > 200) throw new HttpError(400, 'Too many names at once.');
  const insert = db.prepare('INSERT INTO students (name, pin) VALUES (?, ?)');
  const created = [];
  db.exec('BEGIN');
  try {
    for (const raw of names) {
      const name = cleanName(raw);
      const pin = generatePin();
      insert.run(name, pin);
      created.push({ name, pin });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { created };
}));

app.put('/api/admin/students/:id', route((req) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, 'Student not found.');
  const name = req.body.name !== undefined ? cleanName(req.body.name) : cur.name;
  let pin = cur.pin;
  if (req.body.regeneratePin) pin = generatePin();
  else if (req.body.pin !== undefined) pin = cleanPin(req.body.pin);
  const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : cur.active;
  db.prepare('UPDATE students SET name = ?, pin = ?, active = ? WHERE id = ?').run(name, pin, active, id);
  return { id, name, pin, active };
}));

app.delete('/api/admin/students/:id', route((req) => {
  const r = db.prepare('DELETE FROM students WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) throw new HttpError(404, 'Student not found.');
  return { ok: true };
}));

/* ---------------- admin: time entries ---------------- */

app.get('/api/admin/entries', route((req) => {
  const from = parseIso(req.query.from, 'from');
  const to = parseIso(req.query.to, 'to');
  return db.prepare(`
    SELECT e.*, s.name AS student_name
    FROM entries e JOIN students s ON s.id = e.student_id
    WHERE e.clock_in >= ? AND e.clock_in < ?
    ORDER BY s.name COLLATE NOCASE, e.clock_in
  `).all(from, to);
}));

function validateTimes(clockIn, clockOut) {
  if (clockOut && clockOut <= clockIn) throw new HttpError(400, 'Clock out must be after clock in.');
  if (clockOut && new Date(clockOut) - new Date(clockIn) > 24 * 3600 * 1000) {
    throw new HttpError(400, 'An entry cannot be longer than 24 hours.');
  }
}

app.post('/api/admin/entries', route((req) => {
  const studentId = Number(req.body.student_id);
  if (!db.prepare('SELECT 1 FROM students WHERE id = ?').get(studentId)) throw new HttpError(400, 'Choose a student.');
  const clockIn = parseIso(req.body.clock_in, 'Clock in');
  const clockOut = parseIso(req.body.clock_out, 'Clock out', { optional: true });
  validateTimes(clockIn, clockOut);
  const note = String(req.body.note || '').slice(0, 500) || null;
  const r = db.prepare(
    'INSERT INTO entries (student_id, clock_in, clock_out, note, edited_at) VALUES (?, ?, ?, ?, ?)'
  ).run(studentId, clockIn, clockOut, note, new Date().toISOString());
  return { id: Number(r.lastInsertRowid) };
}));

app.put('/api/admin/entries/:id', route((req) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, 'Entry not found.');
  const clockIn = req.body.clock_in !== undefined ? parseIso(req.body.clock_in, 'Clock in') : cur.clock_in;
  const clockOut = req.body.clock_out !== undefined
    ? parseIso(req.body.clock_out, 'Clock out', { optional: true })
    : cur.clock_out;
  validateTimes(clockIn, clockOut);
  const note = req.body.note !== undefined ? (String(req.body.note).slice(0, 500) || null) : cur.note;
  db.prepare('UPDATE entries SET clock_in = ?, clock_out = ?, note = ?, edited_at = ? WHERE id = ?')
    .run(clockIn, clockOut, note, new Date().toISOString(), id);
  return { ok: true };
}));

app.delete('/api/admin/entries/:id', route((req) => {
  const r = db.prepare('DELETE FROM entries WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) throw new HttpError(404, 'Entry not found.');
  return { ok: true };
}));

/* ---------------- admin: settings ---------------- */

app.get('/api/admin/settings', route(() => getSettings()));

app.put('/api/admin/settings', route((req) => {
  const b = req.body || {};
  const patch = {};
  if (b.title !== undefined) patch.title = String(b.title).trim().slice(0, 80) || 'Student Time Clock';
  if (b.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); }
    catch { throw new HttpError(400, 'Unknown time zone.'); }
    patch.timezone = b.timezone;
  }
  return setSettings(patch);
}));

app.listen(PORT, () => {
  console.log(`Time clock running at http://localhost:${PORT}`);
  console.log(`Admin page:          http://localhost:${PORT}/admin`);
});
