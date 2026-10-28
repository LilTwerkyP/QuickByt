'use strict';

// Quick Byt Windows-native backend. Uses only Node.js built-ins: no Docker, WSL,
// npm install, or C compiler is required. Tested with Node.js 22.16+.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 16)) {
  console.error(`You have Node.js ${process.versions.node}. Quick Byt needs Node.js 22.16 or newer.`);
  console.error('Install the current Node.js LTS from https://nodejs.org/ and reopen this window.');
  process.exit(1);
}
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  console.error('Could not load Node.js built-in SQLite. Install Node.js 22.16 or newer from https://nodejs.org/.');
  process.exit(1);
}

const ROOT = __dirname;
const FRONTEND = path.join(ROOT, 'frontend');
const DATA_DIR = path.join(ROOT, 'data');
const SEED_FILE = path.join(ROOT, 'backend', 'menu_seed.json');
const ENV_FILE = path.join(ROOT, '.env');
const MAX_BODY = 64 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
loadDotEnv(ENV_FILE);

const managerPin = process.env.QUICKBYT_MANAGER_PIN || '';
if (managerPin.length < 6 || managerPin.length > 64 || managerPin.startsWith('replace-this-')) {
  console.error('Set QUICKBYT_MANAGER_PIN in the project-root .env file (6–64 characters).');
  console.error('Open .env, replace the sample value, save it, then start Quick Byt again.');
  process.exit(2);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPathSetting = process.env.QUICKBYT_DB_PATH || path.join(DATA_DIR, 'quickbyt.db');
const dbPath = path.isAbsolute(dbPathSetting) ? dbPathSetting : path.resolve(ROOT, dbPathSetting);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
if (!fs.existsSync(SEED_FILE)) {
  console.error(`Cannot find menu data: ${SEED_FILE}`);
  process.exit(1);
}
const menuSeed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA foreign_keys=ON;
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  CREATE TABLE IF NOT EXISTS menu (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
    price INTEGER NOT NULL CHECK(price>=0), is_veg INTEGER NOT NULL DEFAULT 1,
    in_stock INTEGER NOT NULL DEFAULT 1, image TEXT NOT NULL DEFAULT '',
    has_option INTEGER NOT NULL DEFAULT 0, options_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT NOT NULL,
    phone TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    order_type TEXT NOT NULL CHECK(order_type IN ('immediate','preplan')),
    scheduled_slot TEXT NOT NULL DEFAULT '', scheduled_slot_label TEXT NOT NULL DEFAULT '',
    scheduled_date TEXT NOT NULL DEFAULT '',
    payment_method TEXT NOT NULL CHECK(payment_method IN ('UPI','CASH')),
    utr TEXT NOT NULL DEFAULT '', payment_status TEXT NOT NULL DEFAULT 'Pending Verification',
    status TEXT NOT NULL DEFAULT 'Order Placed', total INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, access_token_hash TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_id TEXT NOT NULL, item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity>0), unit_price INTEGER NOT NULL,
    option_text TEXT NOT NULL DEFAULT ''
  );
`);

// Insert/update menu descriptions and prices while preserving each item's saved stock state.
const seedStmt = db.prepare(`INSERT INTO menu(id,name,category,price,is_veg,in_stock,image,has_option,options_json)
  VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
  name=excluded.name, category=excluded.category, price=excluded.price,
  is_veg=excluded.is_veg, image=excluded.image,
  has_option=excluded.has_option, options_json=excluded.options_json`);
const seedTxn = db.prepare('SELECT 1 FROM menu WHERE id=?');
for (const item of menuSeed) {
  if (!item || !item.id || !item.name || !item.category || !Number.isInteger(Number(item.price)) || Number(item.price) < 0) continue;
  seedStmt.run(String(item.id), String(item.name), String(item.category), Number(item.price), item.isVeg ? 1 : 0,
    seedTxn.get(String(item.id)) ? Number(db.prepare('SELECT in_stock FROM menu WHERE id=?').get(String(item.id)).in_stock) : (item.inStock === false ? 0 : 1),
    String(item.image || ''), item.hasOption ? 1 : 0, JSON.stringify(Array.isArray(item.options) ? item.options : []));
}

const sessions = new Map();
const loginAttempts = new Map();
const allowedOrigins = (process.env.QUICKBYT_ALLOWED_ORIGIN || 'http://localhost:5500,http://127.0.0.1:5500')
  .split(',').map(s => s.trim()).filter(Boolean);

function constantTimeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function randomToken() { return crypto.randomBytes(32).toString('hex'); }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function orderId(id) { return `QB-${String(id).padStart(4, '0')}`; }
function parseOrderId(value) {
  const m = String(value || '').match(/^(?:QB-)?(\d{1,12})$/i);
  if (!m) return null;
  const n = Number(m[1]); return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(body);
}
function errorJson(res, status, message) { sendJson(res, status, { error: message }); }
function requestOrigin(req) {
  const requestHost = String(req.headers.host || '');
  if (!requestHost) return '';
  // On hosted platforms such as Render, TLS is terminated by the proxy.
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  return `${protocol}://${requestHost}`;
}
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Order-Token',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS'
    };
  }
  // Same-origin requests need no CORS response headers. Cross-origin requests
  // still require an explicit QUICKBYT_ALLOWED_ORIGIN allow-list entry.
  return {};
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request body is too large'), { status: 413 })); req.destroy(); return; }
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function menuJson() {
  return db.prepare('SELECT id,name,category,price,is_veg,in_stock,image,has_option,options_json FROM menu ORDER BY category,name')
    .all().map(r => ({ id: r.id, name: r.name, category: r.category, price: r.price, isVeg: !!r.is_veg,
      inStock: !!r.in_stock, image: r.image, hasOption: !!r.has_option, options: safeJsonArray(r.options_json) }));
}
function safeJsonArray(raw) { try { const parsed = JSON.parse(raw || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function orderJson(id) {
  const r = db.prepare(`SELECT id,customer_name,phone,note,order_type,scheduled_slot,scheduled_slot_label,scheduled_date,
    payment_method,payment_status,status,total,created_at,utr FROM orders WHERE id=?`).get(id);
  if (!r) return null;
  const items = db.prepare('SELECT item_name,unit_price,quantity,option_text FROM order_items WHERE order_id=? ORDER BY id').all(id)
    .map(it => ({ name: it.item_name, price: it.unit_price, qty: it.quantity, option: it.option_text || '' }));
  return { id: orderId(r.id), customerName: r.customer_name, phone: r.phone, note: r.note, orderType: r.order_type,
    scheduledSlot: r.scheduled_slot_label || r.scheduled_slot || '', scheduledSlotKey: r.scheduled_slot,
    scheduledDate: r.scheduled_date, paymentMethod: r.payment_method, paymentStatus: r.payment_status,
    status: r.status, subtotal: r.total, time: r.created_at, utr: r.utr || '', items };
}
function getManagerSession(req) {
  const auth = String(req.headers.authorization || '');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const expires = sessions.get(match[1]);
  if (!expires || expires <= Date.now()) { sessions.delete(match[1]); return false; }
  return true;
}
function clientIp(req) { return String(req.socket.remoteAddress || 'unknown'); }
function checkLoginAllowed(ip) {
  const track = loginAttempts.get(ip);
  if (!track) return true;
  if (track.blockedUntil > Date.now()) return false;
  if (track.blockedUntil && track.blockedUntil <= Date.now()) loginAttempts.delete(ip);
  return true;
}
function recordFailedLogin(ip) {
  let track = loginAttempts.get(ip);
  if (!track) { track = { failures: 0, blockedUntil: 0 }; loginAttempts.set(ip, track); }
  track.failures++;
  if (track.failures >= MAX_LOGIN_FAILURES) { track.failures = 0; track.blockedUntil = Date.now() + LOGIN_LOCK_MS; }
}
function recordSuccessfulLogin(ip) { loginAttempts.delete(ip); }
function validPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 10 || phone.length > 20 || !/^[-+() 0-9]+$/.test(phone)) return false;
  const count = (phone.match(/\d/g) || []).length; return count >= 10 && count <= 15;
}
function validDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const date = new Date(`${d}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === d;
}
function validSlot(slot) {
  if (typeof slot !== 'string' || !/^\d{2}:\d{2}$/.test(slot)) return false;
  const [hour, minute] = slot.split(':').map(Number);
  return hour >= 11 && hour <= 22 && minute < 60 && minute % 15 === 0 && !(hour === 22 && minute > 15);
}
function readStoredOptions(raw) { return safeJsonArray(raw).filter(x => typeof x === 'string'); }
function managerPatchOrder(idText, body) {
  const id = parseOrderId(idText);
  if (!id) return { status: 400, body: { error: 'Valid order ID required' } };
  const status = body.status;
  const paymentStatus = body.paymentStatus;
  const statuses = ['Order Placed', 'Preparing', 'Ready for Pickup', 'Completed', 'Cancelled'];
  if (status !== undefined && !statuses.includes(status)) return { status: 400, body: { error: 'Invalid order status' } };
  if (paymentStatus !== undefined && paymentStatus !== 'Paid') return { status: 400, body: { error: 'Manager may only confirm payment as Paid after checking the merchant account' } };
  if (status === undefined && paymentStatus === undefined) return { status: 400, body: { error: 'Provide status and/or paymentStatus' } };
  const existing = db.prepare('SELECT payment_method FROM orders WHERE id=?').get(id);
  if (!existing) return { status: 404, body: { error: 'Order not found' } };
  if (paymentStatus === 'Paid' && existing.payment_method !== 'UPI') return { status: 400, body: { error: 'Only UPI orders can be marked paid here; verify cash at the counter' } };
  if (paymentStatus === 'Paid' && status !== undefined) db.prepare("UPDATE orders SET status=?,payment_status='Paid' WHERE id=?").run(status, id);
  else if (paymentStatus === 'Paid') db.prepare("UPDATE orders SET payment_status='Paid' WHERE id=?").run(id);
  else db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, id);
  return { status: 200, body: { status: 'updated' } };
}

async function routeApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;
  const headers = corsHeaders(req);
  if (method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
  if (req.headers.origin && !allowedOrigins.includes(req.headers.origin) &&
      req.headers.origin !== requestOrigin(req) && !['GET', 'HEAD'].includes(method)) {
    errorJson(res, 403, 'Origin is not allowed. Check QUICKBYT_ALLOWED_ORIGIN.'); return;
  }
  let body = {};
  if (method === 'POST' || method === 'PATCH') {
    try { body = await readJsonBody(req); }
    catch (e) { errorJson(res, e.status || 400, e.message || 'Could not read request'); return; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { errorJson(res, 400, 'JSON body must be an object'); return; }
  }

  if (method === 'GET' && pathname === '/api/health') { sendJson(res, 200, { status: 'ok', service: 'Quick Byt Node.js API' }, headers); return; }
  if (method === 'GET' && pathname === '/api/menu') { sendJson(res, 200, menuJson(), headers); return; }

  if (method === 'POST' && pathname === '/api/manager/login') {
    const ip = clientIp(req);
    if (!checkLoginAllowed(ip)) { errorJson(res, 429, 'Too many failed manager logins. Try again in five minutes.'); return; }
    if (typeof body.pin !== 'string' || !constantTimeEqual(body.pin, managerPin)) {
      recordFailedLogin(ip); errorJson(res, 401, 'Invalid manager PIN'); return;
    }
    recordSuccessfulLogin(ip);
    const token = randomToken(); sessions.set(token, Date.now() + SESSION_TTL_MS);
    sendJson(res, 200, { token, expiresInSeconds: SESSION_TTL_MS / 1000 }, headers); return;
  }

  if (method === 'POST' && pathname === '/api/orders') {
    const { customerName: name, phone, note = '', orderType: type, scheduledSlot: slot = '',
      scheduledSlotLabel: slotLabel = '', scheduledDate = '', paymentMethod: payment, utr = '', items } = body;
    if (typeof name !== 'string' || !name.trim() || name.length > 120 || !validPhone(phone) ||
        !['immediate', 'preplan'].includes(type) || !['UPI', 'CASH'].includes(payment) ||
        !Array.isArray(items) || items.length < 1 || items.length > 50) {
      errorJson(res, 400, 'Required: customerName (max 120 chars), valid phone, orderType, paymentMethod and 1–50 items'); return;
    }
    if (typeof note !== 'string' || note.length > 500) { errorJson(res, 400, 'Special instructions must be 500 characters or fewer'); return; }
    if (type === 'preplan' && (!validSlot(slot) || typeof slotLabel !== 'string' || !slotLabel.trim() || slotLabel.length > 64 || !validDate(scheduledDate))) {
      errorJson(res, 400, 'A valid pickup slot, slot label, and YYYY-MM-DD scheduledDate are required'); return;
    }
    if (payment === 'UPI' && (typeof utr !== 'string' || utr.length < 8 || utr.length > 32)) {
      errorJson(res, 400, 'Enter the UPI transaction reference (8–32 characters). Payment remains pending until confirmed by the canteen.'); return;
    }
    const accessToken = randomToken();
    const accessHash = hashToken(accessToken);
    let total = 0; const preparedItems = [];
    try {
      db.exec('BEGIN IMMEDIATE');
      if (type === 'preplan') {
        const capacity = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE scheduled_date=? AND scheduled_slot=? AND order_type='preplan' AND status<>'Cancelled'").get(scheduledDate, slot).count;
        if (capacity >= 4) { db.exec('ROLLBACK'); errorJson(res, 409, 'That pickup slot just filled up. Please choose another slot.'); return; }
      }
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || !item.id || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) {
          db.exec('ROLLBACK'); errorJson(res, 400, 'An item has an invalid ID or quantity'); return;
        }
        const row = db.prepare('SELECT id,name,price,in_stock,has_option,options_json FROM menu WHERE id=?').get(item.id);
        if (!row || !row.in_stock) { db.exec('ROLLBACK'); errorJson(res, 400, 'An item is invalid or out of stock'); return; }
        const option = typeof item.option === 'string' ? item.option : '';
        const options = readStoredOptions(row.options_json);
        if ((row.has_option && !options.includes(option)) || (!row.has_option && option)) {
          db.exec('ROLLBACK'); errorJson(res, 400, `Invalid option for ${row.name}`); return;
        }
        total += row.price * item.quantity;
        if (!Number.isSafeInteger(total) || total > 2147483647) { db.exec('ROLLBACK'); errorJson(res, 400, 'Order total is too large'); return; }
        preparedItems.push({ id: row.id, name: row.name, price: row.price, quantity: item.quantity, option });
      }
      const paymentStatus = payment === 'UPI' ? 'Pending Verification' : 'Cash Due';
      const insert = db.prepare(`INSERT INTO orders(customer_name,phone,note,order_type,scheduled_slot,scheduled_slot_label,scheduled_date,payment_method,utr,payment_status,status,total,access_token_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const result = insert.run(name.trim(), phone, note, type, slot, slotLabel, type === 'preplan' ? scheduledDate : '', payment, payment === 'UPI' ? utr : '', paymentStatus, 'Order Placed', total, accessHash);
      const newId = Number(result.lastInsertRowid);
      const addLine = db.prepare('INSERT INTO order_items(order_id,menu_id,item_name,quantity,unit_price,option_text) VALUES(?,?,?,?,?,?)');
      for (const it of preparedItems) addLine.run(newId, it.id, it.name, it.quantity, it.price, it.option);
      db.exec('COMMIT');
      const order = orderJson(newId);
      order.accessToken = accessToken;
      sendJson(res, 201, order, headers); return;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      console.error('Order creation failed:', error.message);
      errorJson(res, 500, 'Could not save the order. Please retry.'); return;
    }
  }

  const customerMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (method === 'GET' && customerMatch) {
    const id = parseOrderId(decodeURIComponent(customerMatch[1]));
    const token = String(req.headers['x-order-token'] || '');
    if (!id || token.length !== 64) { errorJson(res, 401, 'Order tracking token required'); return; }
    const row = db.prepare('SELECT access_token_hash FROM orders WHERE id=?').get(id);
    if (!row || !constantTimeEqual(row.access_token_hash, hashToken(token))) { errorJson(res, 404, 'Order not found or tracking token is invalid'); return; }
    const order = orderJson(id);
    if (!order) { errorJson(res, 404, 'Order not found'); return; }
    sendJson(res, 200, order, headers); return;
  }
  if (method === 'GET' && pathname === '/api/orders') { errorJson(res, 400, 'Use the per-order tracking token to retrieve an order; phone-only lookup is disabled'); return; }

  if (pathname.startsWith('/api/manager/') && !getManagerSession(req)) {
    errorJson(res, 401, 'Manager authorization required or session expired'); return;
  }
  if (method === 'GET' && pathname === '/api/manager/orders') {
    const ids = db.prepare('SELECT id FROM orders ORDER BY id DESC').all();
    sendJson(res, 200, ids.map(({ id }) => orderJson(id)).filter(Boolean), headers); return;
  }
  const managerOrderMatch = pathname.match(/^\/api\/manager\/orders\/([^/]+)$/);
  if (method === 'PATCH' && managerOrderMatch) {
    const result = managerPatchOrder(decodeURIComponent(managerOrderMatch[1]), body);
    sendJson(res, result.status, result.body, headers); return;
  }
  const managerMenuMatch = pathname.match(/^\/api\/manager\/menu\/([^/]+)$/);
  if (method === 'PATCH' && managerMenuMatch) {
    const id = decodeURIComponent(managerMenuMatch[1]);
    if (typeof body.inStock !== 'boolean') { errorJson(res, 400, 'Provide boolean inStock'); return; }
    const result = db.prepare('UPDATE menu SET in_stock=? WHERE id=?').run(body.inStock ? 1 : 0, id);
    if (Number(result.changes) === 0 && !db.prepare('SELECT 1 FROM menu WHERE id=?').get(id)) { errorJson(res, 404, 'Menu item not found'); return; }
    sendJson(res, 200, { status: 'updated' }, headers); return;
  }
  errorJson(res, 404, 'Route not found');
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon' };
async function handler(req, res) {
  const origin = req.headers.origin;
  const apiPath = (() => { try { return new URL(req.url, 'http://localhost').pathname.startsWith('/api/'); } catch { return false; } })();
  if (apiPath) {
    try { await routeApi(req, res, new URL(req.url, 'http://localhost')); }
    catch (error) { console.error(error); if (!res.headersSent) errorJson(res, 500, 'Unexpected server error'); else res.destroy(); }
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) { errorJson(res, 405, 'Method not allowed'); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { errorJson(res, 400, 'Invalid URL'); return; }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(FRONTEND, `.${pathname}`);
  if (filePath !== FRONTEND && !filePath.startsWith(FRONTEND + path.sep)) { errorJson(res, 403, 'Forbidden'); return; }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { errorJson(res, 404, 'File not found'); return; }
    res.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': path.basename(filePath) === 'config.js' ? 'no-store' : 'no-cache' });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { if (!res.headersSent) errorJson(res, 500, 'Could not read file'); else res.destroy(); });
    stream.pipe(res);
  });
}

const port = Number(process.env.PORT || 5500);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be a valid TCP port number.'); process.exit(2);
}
const host = process.env.HOST || '127.0.0.1';
const server = http.createServer(handler);
server.listen(port, host, () => {
  console.log('');
  console.log('Quick Byt is running.');
  console.log(`Website:       http://localhost:${port}`);
  console.log(`Backend check: http://localhost:${port}/api/health`);
  console.log(`Menu API:      http://localhost:${port}/api/menu`);
  console.log(`Database:      ${dbPath}`);
  console.log('Keep this window open while using the site. Press Ctrl+C to stop.');
  console.log('');
});
function shutdown() {
  console.log('\nStopping Quick Byt...');
  server.close(() => { try { db.close(); } finally { process.exit(0); } });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
