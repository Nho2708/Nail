try { process.loadEnvFile(); } catch { /* .env is optional when env vars are set by the host */ }
process.env.TZ ||= 'Asia/Ho_Chi_Minh'; // "today", opening hours and daily stats follow the salon's clock

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');

const db = require('./src/db');
const { query, one, getSettings, saveSettings, APP_TZ, CACHE_TTL_MS } = db;
const { hashPassword, verifyPassword, newToken, rateLimit } = require('./src/security');
const { validateBooking, validateRegister, clean, normPhone, PHONE_RE } = require('./src/validate');
const { notifyAdmin } = require('./src/notify');
const analytics = require('./src/analytics');
const images = require('./src/images');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const REMEMBER_DAYS = 30; // "Ghi nhớ đăng nhập"
const SHORT_SESSION_HOURS = 12; // not remembered: cookie ends with the browser, server copy after 12h
const LEGACY_UPLOAD_DIR = path.join(__dirname, 'uploads');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Uptime monitors ping this; it must not touch the database so the DB can sleep.
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// ---------------- session ----------------
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Short-lived cache so a logged-in user browsing does not hit the DB on every request.
const sessionCache = new Map();
const SESSION_CACHE_MS = 60_000;
const forgetSessions = () => sessionCache.clear();

const loadUser = h(async (req, res, next) => {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid && /^[a-f0-9]{64}$/.test(sid)) {
    const hit = sessionCache.get(sid);
    if (hit && hit.until > Date.now()) {
      req.user = hit.user;
    } else {
      const row = await one(`SELECT u.id, u.email, u.full_name AS name, u.phone, u.role, s.remember,
          s.expires_at < now() + interval '15 days' AS renew
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = @sid AND s.expires_at > now()`, { sid });
      if (row) {
        const { remember, renew, ...user } = row;
        req.user = user;
        // A remembered login keeps renewing while it is used, so regular customers stay signed in.
        if (remember && renew) {
          await query('UPDATE sessions SET expires_at = now() + make_interval(days => @days) WHERE token = @sid', { sid, days: REMEMBER_DAYS });
          res.setHeader('Set-Cookie', sessionCookie(sid, true));
        }
      } else {
        req.user = null;
      }
      if (sessionCache.size > 1000) sessionCache.clear();
      sessionCache.set(sid, { user: req.user, until: Date.now() + SESSION_CACHE_MS });
    }
  }
  next();
});
app.use(['/api', '/admin'], loadUser);

function sessionCookie(token, remember) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = remember ? `; Max-Age=${REMEMBER_DAYS * 86400}` : ''; // no Max-Age = cleared when the browser closes
  return `sid=${token}; HttpOnly; Path=/; SameSite=Lax${maxAge}${secure}`;
}

async function setSession(res, userId, remember = true) {
  const token = newToken();
  await query(`INSERT INTO sessions (token, user_id, expires_at, remember)
    VALUES (@token, @userId, now() + CASE WHEN @remember THEN make_interval(days => @days) ELSE make_interval(hours => @hours) END, @remember)`,
  { token, userId, remember, days: REMEMBER_DAYS, hours: SHORT_SESSION_HOURS });
  res.setHeader('Set-Cookie', sessionCookie(token, remember));
}

const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Vui lòng đăng nhập.' }));
const requireAdmin = (req, res, next) =>
  req.user?.role === 'admin' ? next() : res.status(req.user ? 403 : 401).json({ error: 'Chỉ dành cho quản trị viên.' });

// State-changing requests must be JSON or multipart (blocks cross-site HTML form posts).
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    const hasBody = Number(req.headers['content-length'] || 0) > 0;
    if (hasBody && !ct.startsWith('application/json') && !ct.startsWith('multipart/form-data'))
      return res.status(415).json({ error: 'Unsupported content type' });
  }
  next();
});

const getUser = (id) => one('SELECT id, email, full_name AS name, phone, role FROM users WHERE id = @id', { id });

// ---------------- public API ----------------
app.get('/api/settings', h(async (req, res) => res.json(await getSettings())));

const DESIGN_COLS = `d.id, d.title, d.description, d.image_url AS image, COALESCE(d.thumb_url, d.image_url) AS thumb,
  d.category_id, d.color_id, d.price, d.is_featured AS featured, d.is_active AS active, d.views`;

// The public catalogue changes only when an admin edits it, so it is cached until then.
let catalogCache = null;
let catalogAt = 0;
const invalidateCatalog = () => { catalogCache = null; };
app.get('/api/catalog', h(async (req, res) => {
  if (!catalogCache || Date.now() - catalogAt > CACHE_TTL_MS) {
    const [categories, colors, services, designs] = await Promise.all([
      query('SELECT id, name, sort_order AS sort FROM categories ORDER BY sort_order, id'),
      query('SELECT id, name, hex, finish, sort_order AS sort FROM colors ORDER BY sort_order, id'),
      query(`SELECT id, name, description, price_from, duration_min AS duration, group_name AS "group"
        FROM services WHERE is_active ORDER BY sort_order, id`),
      query(`SELECT ${DESIGN_COLS} FROM designs d WHERE d.is_active ORDER BY d.is_featured DESC, d.id DESC`),
    ]);
    catalogCache = { categories, colors, services, designs };
    catalogAt = Date.now();
  }
  res.json(catalogCache);
}));

app.post('/api/track', rateLimit({ windowMs: 60_000, max: 60 }), (req, res) => {
  if (req.user?.role === 'admin') return res.json({ ok: true }); // don't count the owner
  const visitor = clean(req.body.visitor).replace(/[^\w-]/g, '').slice(0, 64) || 'anon';
  const p = clean(req.body.path).slice(0, 200) || '/';
  const ua = req.headers['user-agent'] || '';
  const device = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop';
  let ref = '';
  try {
    const u = new URL(clean(req.body.referrer));
    if (u.host !== req.headers.host) ref = u.hostname;
  } catch { /* no/invalid referrer */ }
  analytics.recordVisit({ visitor, path: p, referrer: ref, device });
  const designId = Number(req.body.designId);
  if (Number.isInteger(designId) && designId > 0) analytics.recordDesignView(designId);
  res.json({ ok: true });
});

app.get('/img/:id', h(async (req, res) => {
  if (!/^[a-f0-9]{24}\.(webp|png)$/.test(req.params.id)) return res.status(404).end();
  const img = await images.getImage(req.params.id);
  if (!img) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('ETag', `"${req.params.id}"`);
  res.type(img.type).send(img.data);
}));

// ---------------- auth API ----------------
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, message: 'Quá nhiều lần thử, vui lòng đợi 15 phút.' });

app.get('/api/auth/me', (req, res) => res.json({ user: req.user || null }));

app.post('/api/auth/register', authLimiter, h(async (req, res) => {
  const { data, errors, ok } = validateRegister(req.body);
  if (!ok) return res.status(422).json({ error: 'Thông tin chưa hợp lệ.', fields: errors });
  if (await one('SELECT id FROM users WHERE email = @email', { email: data.email }))
    return res.status(409).json({ error: 'Email đã được sử dụng.', fields: { email: 'Email này đã được đăng ký.' } });
  const r = await one(`INSERT INTO users (email, password_hash, full_name, phone) VALUES (@email, @hash, @name, @phone) RETURNING id`,
    { email: data.email, hash: hashPassword(data.password), name: data.name, phone: data.phone });
  await setSession(res, r.id);
  res.status(201).json({ user: await getUser(r.id) });
}));

app.post('/api/auth/login', authLimiter, h(async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const u = await one('SELECT id, password_hash FROM users WHERE email = @email', { email });
  if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash))
    return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng.' });
  await setSession(res, u.id, ['on', 'true', '1', true, 1].includes(req.body.remember));
  res.json({ user: await getUser(u.id) });
}));

app.post('/api/auth/logout', h(async (req, res) => {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) {
    sessionCache.delete(sid);
    await query('DELETE FROM sessions WHERE token = @sid', { sid });
  }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
}));

app.put('/api/auth/profile', requireAuth, h(async (req, res) => {
  const name = clean(req.body.name);
  const phone = normPhone(req.body.phone);
  const fields = {};
  if (name.length < 2 || name.length > 60) fields.name = 'Họ tên phải từ 2 đến 60 ký tự.';
  if (phone && !PHONE_RE.test(phone)) fields.phone = 'Số điện thoại không hợp lệ.';
  if (req.body.newPassword) {
    const u = await one('SELECT password_hash FROM users WHERE id = @id', { id: req.user.id });
    if (!verifyPassword(String(req.body.currentPassword || ''), u.password_hash)) fields.currentPassword = 'Mật khẩu hiện tại không đúng.';
    const np = String(req.body.newPassword);
    if (np.length < 8 || !/[A-Za-z]/.test(np) || !/\d/.test(np)) fields.newPassword = 'Tối thiểu 8 ký tự, gồm cả chữ và số.';
  }
  if (Object.keys(fields).length) return res.status(422).json({ error: 'Thông tin chưa hợp lệ.', fields });
  await query('UPDATE users SET full_name = @name, phone = @phone WHERE id = @id', { name, phone: phone || null, id: req.user.id });
  if (req.body.newPassword) {
    await query('UPDATE users SET password_hash = @hash WHERE id = @id', { hash: hashPassword(String(req.body.newPassword)), id: req.user.id });
  }
  forgetSessions();
  res.json({ user: await getUser(req.user.id) });
}));

// ---------------- bookings ----------------
const BOOKING_SELECT = `SELECT b.id, b.kind AS type, b.user_id, b.full_name AS name, b.phone, b.email,
  to_char(b.booking_date, 'YYYY-MM-DD') AS date, b.booking_time AS time, b.service_id, b.design_id,
  b.color_id, b.custom_color, b.note, b.status, b.notify_result AS notified, b.created_at,
  s.name AS service_name, d.title AS design_title, COALESCE(d.thumb_url, d.image_url) AS design_thumb,
  c.name AS color_name, c.hex AS color_hex
  FROM bookings b
  LEFT JOIN services s ON s.id = b.service_id
  LEFT JOIN designs d ON d.id = b.design_id
  LEFT JOIN colors c ON c.id = b.color_id`;

const bookingLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10, message: 'Bạn đã gửi quá nhiều yêu cầu, vui lòng thử lại sau.' });

app.post('/api/bookings', bookingLimiter, h(async (req, res) => {
  const body = { ...req.body };
  // Logged-in customers: contact info is taken from their account automatically.
  if (req.user) {
    body.name = clean(body.name) || req.user.name;
    body.phone = clean(body.phone) || req.user.phone;
    body.email = clean(body.email) || req.user.email;
  }
  const s = await getSettings();
  const requireService = !!(await one('SELECT id FROM services WHERE is_active LIMIT 1'));
  const { data, errors } = validateBooking(body, { openTime: s.openTime, closeTime: s.closeTime, requireService });
  const refs = [['service_id', 'services'], ['design_id', 'designs'], ['color_id', 'colors']];
  for (const [k, table] of refs) {
    if (data[k] && !(await one(`SELECT id FROM ${table} WHERE id = @id`, { id: data[k] }))) errors[k] = 'Lựa chọn không còn tồn tại.';
  }
  if (Object.keys(errors).length) return res.status(422).json({ error: 'Vui lòng kiểm tra lại thông tin.', fields: errors });

  const capacity = Math.max(1, Number(s.slotCapacity) || 3);
  const params = {
    kind: data.type, userId: req.user?.id ?? null, name: data.name, phone: data.phone, email: data.email || null,
    date: data.date, time: data.time, serviceId: data.service_id, designId: data.design_id, colorId: data.color_id,
    customColor: data.custom_color, note: data.note || null,
  };
  // A per-slot advisory lock makes "count, then insert" atomic, so two customers can't overbook a slot.
  const created = await db.transaction(async (tx) => {
    if (data.type === 'booking') {
      await query("SELECT pg_advisory_xact_lock(hashtext(@date::text || ' ' || @time::text))", params, tx);
      const taken = await one(`SELECT COUNT(*) AS n FROM bookings
        WHERE booking_date = @date::date AND booking_time = @time AND status IN ('pending', 'confirmed')`, params, tx);
      if (taken.n >= capacity) return null;
    }
    return one(`INSERT INTO bookings (kind, user_id, full_name, phone, email, booking_date, booking_time, service_id, design_id, color_id, custom_color, note)
      VALUES (@kind, @userId, @name, @phone, @email, @date::date, @time, @serviceId, @designId, @colorId, @customColor, @note)
      RETURNING id`, params, tx);
  });
  if (!created) return res.status(409).json({ error: 'Khung giờ này vừa kín lịch, vui lòng chọn giờ khác.', fields: { time: 'Khung giờ đã kín.' } });

  const booking = await one(`${BOOKING_SELECT} WHERE b.id = @id`, { id: created.id });
  // Notify the admin in the background; the result is shown in the admin panel.
  notifyAdmin(booking)
    .then((result) => query('UPDATE bookings SET notify_result = @r WHERE id = @id', { r: JSON.stringify(result), id: booking.id }))
    .catch((e) => console.warn('[notify]', e.message));
  res.status(201).json({ booking });
}));

app.get('/api/bookings/mine', requireAuth, h(async (req, res) => {
  res.json({ bookings: await query(`${BOOKING_SELECT} WHERE b.user_id = @id ORDER BY b.id DESC`, { id: req.user.id }) });
}));

app.post('/api/bookings/:id/cancel', requireAuth, h(async (req, res) => {
  const b = await one('SELECT id, status FROM bookings WHERE id = @id AND user_id = @uid', { id: Number(req.params.id) || 0, uid: req.user.id });
  if (!b) return res.status(404).json({ error: 'Không tìm thấy lịch hẹn.' });
  if (!['pending', 'confirmed'].includes(b.status)) return res.status(400).json({ error: 'Lịch hẹn này không thể hủy.' });
  await query("UPDATE bookings SET status = 'cancelled' WHERE id = @id", { id: b.id });
  res.json({ ok: true });
}));

app.get('/api/slots', h(async (req, res) => {
  const date = clean(req.query.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.json({ full: [] });
  const s = await getSettings();
  const capacity = Math.max(1, Number(s.slotCapacity) || 3);
  const rows = await query(`SELECT booking_time AS time, COUNT(*) AS n FROM bookings
    WHERE booking_date = @date::date AND status IN ('pending', 'confirmed') GROUP BY booking_time`, { date });
  res.json({ full: rows.filter((r) => r.n >= capacity).map((r) => r.time) });
}));

// ---------------- admin API ----------------
const admin = express.Router();
admin.use(requireAdmin);

const localDay = (col) => `to_char(${col} AT TIME ZONE '${APP_TZ}', 'YYYY-MM-DD')`;
function localMidnight(daysBack = 0) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack); // process TZ = salon TZ
}

admin.get('/stats', h(async (req, res) => {
  await analytics.flush(); // include page views still buffered in memory
  const days = Math.min(Math.max(Number(req.query.days) || 14, 7), 90);
  const p = { since: localMidnight(days - 1), today: localMidnight(0) };
  const [totals, series, bookingSeries, devices, referrers, topDesigns] = await Promise.all([
    one(`SELECT
      (SELECT COUNT(*) FROM visits WHERE created_at >= @since) AS views,
      (SELECT COUNT(DISTINCT visitor_id) FROM visits WHERE created_at >= @since) AS visitors,
      (SELECT COUNT(*) FROM visits WHERE created_at >= @today) AS today,
      (SELECT COUNT(DISTINCT visitor_id) FROM visits WHERE created_at >= @today) AS "todayVisitors",
      (SELECT COUNT(*) FROM visits) AS "allViews",
      (SELECT COUNT(*) FROM bookings WHERE kind = 'booking' AND created_at >= @since) AS bookings,
      (SELECT COUNT(*) FROM bookings WHERE kind = 'consult' AND created_at >= @since) AS consults,
      (SELECT COUNT(*) FROM bookings WHERE status = 'pending') AS pending,
      (SELECT COUNT(*) FROM users WHERE role = 'customer') AS customers`, p),
    query(`SELECT ${localDay('created_at')} AS day, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
      FROM visits WHERE created_at >= @since GROUP BY 1`, p),
    query(`SELECT ${localDay('created_at')} AS day, COUNT(*) AS n FROM bookings WHERE created_at >= @since GROUP BY 1`, p),
    query(`SELECT COALESCE(device, 'desktop') AS device, COUNT(*) AS n FROM visits WHERE created_at >= @since
      GROUP BY 1 ORDER BY n DESC`, p),
    query(`SELECT COALESCE(referrer, 'Truy cập trực tiếp') AS ref, COUNT(*) AS n FROM visits WHERE created_at >= @since
      GROUP BY 1 ORDER BY n DESC LIMIT 6`, p),
    query(`SELECT id, title, COALESCE(thumb_url, image_url) AS thumb, views FROM designs
      WHERE views > 0 ORDER BY views DESC LIMIT 5`),
  ]);
  const vmap = Object.fromEntries(series.map((r) => [r.day, r]));
  const bmap = Object.fromEntries(bookingSeries.map((r) => [r.day, r.n]));
  const filled = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = localMidnight(i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    filled.push({ day: key, views: vmap[key]?.views || 0, visitors: vmap[key]?.visitors || 0, bookings: bmap[key] || 0 });
  }
  res.json({ days, totals, series: filled, devices, referrers, topDesigns });
}));

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();

admin.get('/bookings', h(async (req, res) => {
  const where = [];
  const p = {};
  if (['pending', 'confirmed', 'done', 'cancelled'].includes(req.query.status)) { where.push('b.status = @status'); p.status = req.query.status; }
  if (['booking', 'consult'].includes(req.query.type)) { where.push('b.kind = @kind'); p.kind = req.query.type; }
  if (req.query.since) { where.push('b.id > @since'); p.since = Number(req.query.since) || 0; }
  // Name/phone search is done here, accent- and case-insensitively ("dong" finds "Đồng"),
  // independent of the database's locale settings.
  const q = fold(clean(req.query.q).slice(0, 60));
  const sqlText = `${BOOKING_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.id DESC ${q ? '' : 'LIMIT 300'}`;
  let bookings = await query(sqlText, p);
  if (q) bookings = bookings.filter((b) => fold(b.name).includes(q) || b.phone.includes(q)).slice(0, 300);
  res.json({ bookings });
}));

admin.patch('/bookings/:id', h(async (req, res) => {
  const status = req.body.status;
  if (!['pending', 'confirmed', 'done', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ.' });
  await query('UPDATE bookings SET status = @status WHERE id = @id', { status, id: Number(req.params.id) || 0 });
  res.json({ ok: true });
}));

admin.delete('/bookings/:id', h(async (req, res) => {
  await query('DELETE FROM bookings WHERE id = @id', { id: Number(req.params.id) || 0 });
  res.json({ ok: true });
}));

admin.get('/customers', h(async (req, res) => {
  res.json({ customers: await query(`SELECT u.id, u.email, u.full_name AS name, u.phone, u.role, u.created_at,
    (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id) AS bookings
    FROM users u ORDER BY u.id DESC`) });
}));

admin.patch('/customers/:id', h(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const role = req.body.role;
  if (!['admin', 'customer'].includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ.' });
  if (id === req.user.id) return res.status(400).json({ error: 'Bạn không thể tự đổi quyền của chính mình.' });
  await query('UPDATE users SET role = @role WHERE id = @id', { role, id });
  if (role === 'customer') await query('DELETE FROM sessions WHERE user_id = @id', { id }); // revoke admin sessions
  forgetSessions();
  res.json({ ok: true });
}));

// ----- image upload: re-encoded to WebP (strips metadata, bounds size), stored in the DB -----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|avif)$/.test(file.mimetype)),
});

// Favicon: the logo on a rounded tile whose shade contrasts with the logo,
// so it stays visible on both light and dark browser tab bars.
async function makeFavicon(logo) {
  const S = 64, PAD = 7;
  const mark = await logo.clone().resize(S - PAD * 2, S - PAD * 2, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let lum = 0, weight = 0;
  for (let i = 0; i < mark.data.length; i += 4) {
    const a = mark.data[i + 3] / 255;
    lum += a * (0.2126 * mark.data[i] + 0.7152 * mark.data[i + 1] + 0.0722 * mark.data[i + 2]) / 255;
    weight += a;
  }
  const tile = weight && lum / weight < 0.55 ? '#FBF7F4' : '#2E1A24';
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><rect width="${S}" height="${S}" rx="14" fill="${tile}"/></svg>`);
  return sharp(bg)
    .composite([{ input: mark.data, raw: { width: mark.info.width, height: mark.info.height, channels: 4 }, left: PAD, top: PAD }])
    .png().toBuffer();
}

admin.post('/upload', upload.single('image'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chỉ nhận ảnh JPG, PNG, WEBP, AVIF tối đa 8MB.' });
  let buffers;
  try {
    const img = sharp(req.file.buffer, { failOn: 'error' }).rotate();
    if (req.query.kind === 'logo') {
      // Logo keeps transparency; empty margins are trimmed so the mark fills its height.
      let logo = img;
      try {
        logo = sharp(await img.clone().trim({ threshold: 10 }).png().toBuffer());
      } catch { /* uniform image: nothing to trim */ }
      buffers = {
        logo: await logo.clone().resize({ width: 800, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90, alphaQuality: 100 }).toBuffer(),
        icon: await makeFavicon(logo),
      };
    } else if (req.query.kind === 'menu') {
      // A photographed / designed price list: keep it large and sharp enough to read when zoomed.
      buffers = {
        full: await img.clone().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 86 }).toBuffer(),
        thumb: await img.clone().resize({ width: 1100, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
      };
    } else {
      buffers = {
        full: await img.clone().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
        thumb: await img.clone().resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(),
      };
    }
  } catch {
    return res.status(400).json({ error: 'File ảnh bị lỗi hoặc không được hỗ trợ.' });
  }
  if (buffers.logo) {
    const url = await images.saveImage(buffers.logo, 'webp');
    return res.json({ url, thumb: url, icon: await images.saveImage(buffers.icon, 'png') });
  }
  res.json({ url: await images.saveImage(buffers.full, 'webp'), thumb: await images.saveImage(buffers.thumb, 'webp') });
}));

// ----- designs -----
admin.get('/designs', h(async (req, res) => {
  res.json({ designs: await query(`SELECT ${DESIGN_COLS} FROM designs d ORDER BY d.id DESC`) });
}));

// Only images served by this site are accepted (DB images, bundled images, legacy local uploads).
const localImage = (v) => {
  const s = clean(v);
  return /^\/img\/[a-f0-9]{24}\.(webp|png)$/.test(s) || (/^\/(images|uploads)\/[\w./-]+$/.test(s) && !s.includes('..')) ? s : '';
};

function designParams(b) {
  const title = clean(b.title);
  if (title.length < 2 || title.length > 80) return { error: 'Tên mẫu từ 2 đến 80 ký tự.' };
  const image = localImage(b.image);
  if (!image) return { error: 'Vui lòng tải ảnh cho mẫu nail.' };
  return {
    p: {
      title, description: clean(b.description).slice(0, 500) || null, image, thumb: localImage(b.thumb) || null,
      categoryId: Number(b.category_id) || null, colorId: Number(b.color_id) || null,
      price: Math.max(0, Math.round(Number(b.price) || 0)), featured: !!b.featured, active: b.active !== false,
    },
  };
}

admin.post('/designs', h(async (req, res) => {
  const { p, error } = designParams(req.body);
  if (error) return res.status(422).json({ error });
  const r = await one(`INSERT INTO designs (title, description, image_url, thumb_url, category_id, color_id, price, is_featured, is_active)
    VALUES (@title, @description, @image, @thumb, @categoryId, @colorId, @price, @featured, @active) RETURNING id`, p);
  invalidateCatalog();
  res.status(201).json(r);
}));

admin.put('/designs/:id', h(async (req, res) => {
  const { p, error } = designParams(req.body);
  if (error) return res.status(422).json({ error });
  await query(`UPDATE designs SET title = @title, description = @description, image_url = @image, thumb_url = @thumb,
    category_id = @categoryId, color_id = @colorId, price = @price, is_featured = @featured, is_active = @active WHERE id = @id`,
  { ...p, id: Number(req.params.id) || 0 });
  invalidateCatalog();
  res.json({ ok: true });
}));

admin.delete('/designs/:id', h(async (req, res) => {
  await query('DELETE FROM designs WHERE id = @id', { id: Number(req.params.id) || 0 });
  invalidateCatalog();
  res.json({ ok: true });
}));

// ----- colors / categories / services -----
function crud(route, table, map, validate) {
  const cols = Object.keys(map);
  admin.post(`/${route}`, h(async (req, res) => {
    const e = validate(req.body); if (e) return res.status(422).json({ error: e });
    const p = Object.fromEntries(cols.map((c) => [c, map[c](req.body)]));
    const r = await one(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')}) RETURNING id`, p);
    invalidateCatalog();
    res.status(201).json(r);
  }));
  admin.put(`/${route}/:id`, h(async (req, res) => {
    const e = validate(req.body); if (e) return res.status(422).json({ error: e });
    const p = Object.fromEntries(cols.map((c) => [c, map[c](req.body)]));
    await query(`UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`, { ...p, id: Number(req.params.id) || 0 });
    invalidateCatalog();
    res.json({ ok: true });
  }));
  admin.delete(`/${route}/:id`, h(async (req, res) => {
    await query(`DELETE FROM ${table} WHERE id = @id`, { id: Number(req.params.id) || 0 });
    invalidateCatalog();
    res.json({ ok: true });
  }));
}
const text = (k, max) => (b) => clean(b[k]).slice(0, max) || null;
const int = (k) => (b) => Math.max(0, Math.round(Number(b[k]) || 0));
const flag = (k) => (b) => b[k] !== false && b[k] !== 0 && b[k] !== '0';

crud('colors', 'colors',
  { name: text('name', 40), hex: (b) => clean(b.hex).toUpperCase(), finish: (b) => (['gloss', 'matte', 'chrome', 'cateye'].includes(b.finish) ? b.finish : 'gloss'), sort_order: int('sort') },
  (b) => (clean(b.name).length < 2 ? 'Tên màu tối thiểu 2 ký tự.' : !/^#[0-9a-f]{6}$/i.test(clean(b.hex)) ? 'Mã màu phải có dạng #RRGGBB.' : null));
crud('categories', 'categories',
  { name: text('name', 40), sort_order: int('sort') },
  (b) => (clean(b.name).length < 2 ? 'Tên danh mục tối thiểu 2 ký tự.' : null));
crud('services', 'services',
  { name: text('name', 80), group_name: text('group', 40), description: text('description', 300), price_from: int('price_from'),
    duration_min: int('duration'), sort_order: int('sort'), is_active: flag('active') },
  (b) => (clean(b.name).length < 2 ? 'Tên dịch vụ tối thiểu 2 ký tự.' : null));

admin.get('/services', h(async (req, res) => {
  res.json({ services: await query(`SELECT id, name, group_name AS "group", description, price_from, duration_min AS duration,
    sort_order AS sort, is_active AS active FROM services ORDER BY sort_order, id`) });
}));

// ----- settings & notifications -----
admin.get('/settings', h(async (req, res) => res.json(await getSettings({ includePrivate: true }))));
admin.put('/settings', h(async (req, res) => {
  const b = req.body || {};
  for (const k of ['primaryColor', 'accentColor', 'bgColor', 'textColor']) {
    if (b[k] != null && !/^#[0-9a-f]{6}$/i.test(b[k])) return res.status(422).json({ error: `Mã màu "${k}" không hợp lệ.` });
  }
  for (const k of ['openTime', 'closeTime']) {
    if (b[k] != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b[k])) return res.status(422).json({ error: 'Giờ mở/đóng cửa phải dạng HH:mm.' });
  }
  if (b.heroImage != null && b.heroImage !== '' && !localImage(b.heroImage)) return res.status(422).json({ error: 'Ảnh hero không hợp lệ.' });
  if (b.aboutImage != null && b.aboutImage !== '' && !localImage(b.aboutImage)) return res.status(422).json({ error: 'Ảnh giới thiệu không hợp lệ.' });
  for (const k of ['servicesMenuImage', 'servicesMenuThumb']) {
    if (b[k] != null && b[k] !== '' && !localImage(b[k])) return res.status(422).json({ error: 'Ảnh menu dịch vụ không hợp lệ, vui lòng tải lại.' });
  }
  if (b.servicesImageSide != null && !['left', 'right'].includes(b.servicesImageSide)) return res.status(422).json({ error: 'Vị trí ảnh menu không hợp lệ.' });
  for (const k of ['logoImage', 'logoIcon']) {
    if (b[k] != null && b[k] !== '' && !localImage(b[k])) return res.status(422).json({ error: 'Logo không hợp lệ, vui lòng tải lại.' });
  }
  if (b.logoHeight != null) {
    const n = Number(b.logoHeight);
    if (!Number.isInteger(n) || n < 24 || n > 96) return res.status(422).json({ error: 'Chiều cao logo phải từ 24 đến 96px.' });
  }
  if (b.notifyWebhookUrl && !/^https:\/\//.test(b.notifyWebhookUrl)) return res.status(422).json({ error: 'Webhook phải là URL https://' });
  await saveSettings(b);
  res.json(await getSettings({ includePrivate: true }));
}));

admin.post('/notify-test', h(async (req, res) => {
  const now = new Date();
  const sample = {
    id: 0, type: 'booking', name: 'Tin nhắn kiểm tra', phone: '—',
    date: now.toISOString().slice(0, 10), time: now.toTimeString().slice(0, 5),
    note: 'Nếu bạn nhận được tin này, kênh thông báo đã cấu hình đúng.', user_id: null,
  };
  const channel = ['telegram', 'zalo', 'messenger', 'webhook'].includes(req.body.channel) ? req.body.channel : undefined;
  res.json({ result: await notifyAdmin(sample, channel) });
}));

app.use('/api/admin', admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy API.' }));

// ---------------- static ----------------
if (fs.existsSync(LEGACY_UPLOAD_DIR)) app.use('/uploads', express.static(LEGACY_UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three'), { maxAge: '7d' }));
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules/chart.js/dist'), { maxAge: '7d' }));
app.get(['/admin', '/admin/', '/admin/index.html'], (req, res) => {
  if (req.user?.role !== 'admin') return res.redirect('/?login=admin');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});
// Home page: put the configured tab title in the HTML so it is right before JS runs (and for link previews).
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
app.get(['/', '/index.html'], h(async (req, res) => {
  const s = await getSettings();
  const title = (s.siteTitle || '').trim() || [s.brandName, s.tagline].filter(Boolean).join(' · ');
  const html = (await fs.promises.readFile(INDEX_HTML, 'utf8')).replace(/<title>[^<]*<\/title>/, `<title>${escHtml(title)}</title>`);
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
}));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: 0 }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Ảnh vượt quá 8MB hoặc không hợp lệ.' });
  console.error(err);
  res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
});

// ---------------- start / stop ----------------
let server;
db.init()
  .then(() => {
    server = app.listen(PORT, () => console.log(`Nail studio: http://localhost:${PORT}   ·   Quản trị: http://localhost:${PORT}/admin`));
    images.purgeOrphans().catch((e) => console.warn('[images]', e.message));
    setInterval(() => images.purgeOrphans().catch(() => {}), 24 * 3600_000).unref();
  })
  .catch((e) => {
    console.error('Không kết nối được PostgreSQL:', e.message);
    console.error('Kiểm tra DATABASE_URL trong file .env (hoặc biến môi trường trên host).');
    process.exit(1);
  });

// Hosts stop the app with SIGTERM on deploy/restart: save buffered page views first.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server?.close();
    await analytics.flush().catch(() => {});
    await db.pool.end().catch(() => {});
    process.exit(0);
  });
}
