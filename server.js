try { process.loadEnvFile(); } catch { /* .env is optional when env vars are set externally */ }

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

const db = require('./src/db');
const { query, one, getSettings, saveSettings } = db;
const { hashPassword, verifyPassword, newToken, rateLimit } = require('./src/security');
const { validateBooking, validateRegister, clean, normPhone, PHONE_RE } = require('./src/validate');
const { notifyAdmin } = require('./src/notify');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SESSION_DAYS = 14;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

// ---------------- session ----------------
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const loadUser = h(async (req, res, next) => {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid && /^[a-f0-9]{64}$/.test(sid)) {
    req.user = await one(`SELECT u.Id AS id, u.Email AS email, u.FullName AS name, u.Phone AS phone, u.Role AS role
      FROM dbo.Sessions s JOIN dbo.Users u ON u.Id = s.UserId WHERE s.Token = @sid AND s.ExpiresAt > SYSDATETIME()`, { sid });
  }
  next();
});
app.use(['/api', '/admin'], loadUser);

async function setSession(res, userId) {
  const token = newToken();
  const maxAge = SESSION_DAYS * 86400;
  await query('INSERT INTO dbo.Sessions(Token, UserId, ExpiresAt) VALUES (@token, @userId, DATEADD(day, @days, SYSDATETIME()))',
    { token, userId, days: SESSION_DAYS });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`);
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

const USER_COLS = 'Id AS id, Email AS email, FullName AS name, Phone AS phone, Role AS role';
const getUser = (id) => one(`SELECT ${USER_COLS} FROM dbo.Users WHERE Id = @id`, { id });

// ---------------- public API ----------------
app.get('/api/settings', h(async (req, res) => res.json(await getSettings())));

const DESIGN_COLS = `d.Id AS id, d.Title AS title, d.Description AS description, d.ImageUrl AS image,
  COALESCE(d.ThumbUrl, d.ImageUrl) AS thumb, d.CategoryId AS category_id, d.ColorId AS color_id,
  d.Price AS price, d.IsFeatured AS featured, d.IsActive AS active, d.Views AS views`;

app.get('/api/catalog', h(async (req, res) => {
  const [categories, colors, services, designs] = await Promise.all([
    query('SELECT Id AS id, Name AS name, SortOrder AS sort FROM dbo.Categories ORDER BY SortOrder, Id'),
    query('SELECT Id AS id, Name AS name, Hex AS hex, Finish AS finish, SortOrder AS sort FROM dbo.Colors ORDER BY SortOrder, Id'),
    query(`SELECT Id AS id, Name AS name, Description AS description, PriceFrom AS price_from, DurationMin AS duration,
      ImageUrl AS image FROM dbo.Services WHERE IsActive = 1 ORDER BY SortOrder, Id`),
    query(`SELECT ${DESIGN_COLS} FROM dbo.Designs d WHERE d.IsActive = 1 ORDER BY d.IsFeatured DESC, d.Id DESC`),
  ]);
  res.json({ categories, colors, services, designs });
}));

app.post('/api/track', rateLimit({ windowMs: 60_000, max: 60 }), h(async (req, res) => {
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
  await query('INSERT INTO dbo.Visits(VisitorId, Path, Referrer, Device) VALUES (@visitor, @p, @ref, @device)',
    { visitor, p, ref: ref || null, device });
  const designId = Number(req.body.designId);
  if (Number.isInteger(designId) && designId > 0) await query('UPDATE dbo.Designs SET Views = Views + 1 WHERE Id = @designId', { designId });
  res.json({ ok: true });
}));

// ---------------- auth API ----------------
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, message: 'Quá nhiều lần thử, vui lòng đợi 15 phút.' });

app.get('/api/auth/me', (req, res) => res.json({ user: req.user || null }));

app.post('/api/auth/register', authLimiter, h(async (req, res) => {
  const { data, errors, ok } = validateRegister(req.body);
  if (!ok) return res.status(422).json({ error: 'Thông tin chưa hợp lệ.', fields: errors });
  if (await one('SELECT Id FROM dbo.Users WHERE Email = @email', { email: data.email }))
    return res.status(409).json({ error: 'Email đã được sử dụng.', fields: { email: 'Email này đã được đăng ký.' } });
  const r = await one(`INSERT INTO dbo.Users(Email, PasswordHash, FullName, Phone) OUTPUT INSERTED.Id AS id
    VALUES (@email, @hash, @name, @phone)`, { email: data.email, hash: hashPassword(data.password), name: data.name, phone: data.phone });
  await setSession(res, r.id);
  res.status(201).json({ user: await getUser(r.id) });
}));

app.post('/api/auth/login', authLimiter, h(async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const u = await one('SELECT Id, PasswordHash FROM dbo.Users WHERE Email = @email', { email });
  if (!u || !verifyPassword(String(req.body.password || ''), u.PasswordHash))
    return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng.' });
  await setSession(res, u.Id);
  res.json({ user: await getUser(u.Id) });
}));

app.post('/api/auth/logout', h(async (req, res) => {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) await query('DELETE FROM dbo.Sessions WHERE Token = @sid', { sid });
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
    const u = await one('SELECT PasswordHash FROM dbo.Users WHERE Id = @id', { id: req.user.id });
    if (!verifyPassword(String(req.body.currentPassword || ''), u.PasswordHash)) fields.currentPassword = 'Mật khẩu hiện tại không đúng.';
    const np = String(req.body.newPassword);
    if (np.length < 8 || !/[A-Za-z]/.test(np) || !/\d/.test(np)) fields.newPassword = 'Tối thiểu 8 ký tự, gồm cả chữ và số.';
  }
  if (Object.keys(fields).length) return res.status(422).json({ error: 'Thông tin chưa hợp lệ.', fields });
  await query('UPDATE dbo.Users SET FullName = @name, Phone = @phone WHERE Id = @id', { name, phone: phone || null, id: req.user.id });
  if (req.body.newPassword) {
    await query('UPDATE dbo.Users SET PasswordHash = @hash WHERE Id = @id', { hash: hashPassword(String(req.body.newPassword)), id: req.user.id });
  }
  res.json({ user: await getUser(req.user.id) });
}));

// ---------------- bookings ----------------
const BOOKING_SELECT = `SELECT b.Id AS id, b.Kind AS type, b.UserId AS user_id, b.FullName AS name, b.Phone AS phone, b.Email AS email,
  CONVERT(char(10), b.BookingDate, 23) AS date, b.BookingTime AS time, b.ServiceId AS service_id, b.DesignId AS design_id,
  b.ColorId AS color_id, b.CustomColor AS custom_color, b.Note AS note, b.Status AS status, b.NotifyResult AS notified,
  b.CreatedAt AS created_at, s.Name AS service_name, d.Title AS design_title, COALESCE(d.ThumbUrl, d.ImageUrl) AS design_thumb,
  c.Name AS color_name, c.Hex AS color_hex
  FROM dbo.Bookings b
  LEFT JOIN dbo.Services s ON s.Id = b.ServiceId
  LEFT JOIN dbo.Designs d ON d.Id = b.DesignId
  LEFT JOIN dbo.Colors c ON c.Id = b.ColorId`;

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
  const requireService = !!(await one('SELECT TOP 1 Id FROM dbo.Services WHERE IsActive = 1'));
  const { data, errors } = validateBooking(body, { openTime: s.openTime, closeTime: s.closeTime, requireService });
  const refs = [['service_id', 'Services'], ['design_id', 'Designs'], ['color_id', 'Colors']];
  for (const [k, table] of refs) {
    if (data[k] && !(await one(`SELECT Id FROM dbo.${table} WHERE Id = @id`, { id: data[k] }))) errors[k] = 'Lựa chọn không còn tồn tại.';
  }
  if (Object.keys(errors).length) return res.status(422).json({ error: 'Vui lòng kiểm tra lại thông tin.', fields: errors });

  const capacity = Math.max(1, Number(s.slotCapacity) || 3);
  const params = {
    kind: data.type, userId: req.user?.id ?? null, name: data.name, phone: data.phone, email: data.email || null,
    date: data.date, time: data.time, serviceId: data.service_id, designId: data.design_id, colorId: data.color_id,
    customColor: data.custom_color, note: data.note || null, capacity,
  };
  // Capacity check + insert in one serializable transaction so two customers can't overbook a slot.
  const created = await db.transaction(async (tx) => {
    if (data.type === 'booking') {
      const taken = await one(`SELECT COUNT(*) AS n FROM dbo.Bookings WITH (UPDLOCK, HOLDLOCK)
        WHERE BookingDate = @date AND BookingTime = @time AND Status IN ('pending','confirmed')`, params, tx);
      if (taken.n >= capacity) return null;
    }
    return one(`INSERT INTO dbo.Bookings(Kind, UserId, FullName, Phone, Email, BookingDate, BookingTime, ServiceId, DesignId, ColorId, CustomColor, Note)
      OUTPUT INSERTED.Id AS id
      VALUES (@kind, @userId, @name, @phone, @email, @date, @time, @serviceId, @designId, @colorId, @customColor, @note)`, params, tx);
  });
  if (!created) return res.status(409).json({ error: 'Khung giờ này vừa kín lịch, vui lòng chọn giờ khác.', fields: { time: 'Khung giờ đã kín.' } });

  const booking = await one(`${BOOKING_SELECT} WHERE b.Id = @id`, { id: created.id });
  // Notify admin in the background; the result is shown in the admin panel.
  notifyAdmin(booking)
    .then((result) => query('UPDATE dbo.Bookings SET NotifyResult = @r WHERE Id = @id', { r: JSON.stringify(result), id: booking.id }))
    .catch((e) => console.warn('[notify]', e.message));
  res.status(201).json({ booking });
}));

app.get('/api/bookings/mine', requireAuth, h(async (req, res) => {
  res.json({ bookings: await query(`${BOOKING_SELECT} WHERE b.UserId = @id ORDER BY b.Id DESC`, { id: req.user.id }) });
}));

app.post('/api/bookings/:id/cancel', requireAuth, h(async (req, res) => {
  const b = await one('SELECT Id, Status FROM dbo.Bookings WHERE Id = @id AND UserId = @uid', { id: Number(req.params.id), uid: req.user.id });
  if (!b) return res.status(404).json({ error: 'Không tìm thấy lịch hẹn.' });
  if (!['pending', 'confirmed'].includes(b.Status)) return res.status(400).json({ error: 'Lịch hẹn này không thể hủy.' });
  await query("UPDATE dbo.Bookings SET Status = 'cancelled' WHERE Id = @id", { id: b.Id });
  res.json({ ok: true });
}));

app.get('/api/slots', h(async (req, res) => {
  const date = clean(req.query.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.json({ full: [] });
  const s = await getSettings();
  const capacity = Math.max(1, Number(s.slotCapacity) || 3);
  const rows = await query(`SELECT BookingTime AS time, COUNT(*) AS n FROM dbo.Bookings
    WHERE BookingDate = @date AND Status IN ('pending','confirmed') GROUP BY BookingTime`, { date });
  res.json({ full: rows.filter((r) => r.n >= capacity).map((r) => r.time) });
}));

// ---------------- admin API ----------------
const admin = express.Router();
admin.use(requireAdmin);

admin.get('/stats', h(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 14, 7), 90);
  const p = { back: days - 1 };
  const inRange = 'CreatedAt >= DATEADD(day, -@back, CAST(GETDATE() AS date))';
  const isToday = 'CreatedAt >= CAST(GETDATE() AS date)';
  const [totals, series, bookingSeries, devices, referrers, topDesigns] = await Promise.all([
    one(`SELECT
      (SELECT COUNT(*) FROM dbo.Visits WHERE ${inRange}) AS views,
      (SELECT COUNT(DISTINCT VisitorId) FROM dbo.Visits WHERE ${inRange}) AS visitors,
      (SELECT COUNT(*) FROM dbo.Visits WHERE ${isToday}) AS today,
      (SELECT COUNT(DISTINCT VisitorId) FROM dbo.Visits WHERE ${isToday}) AS todayVisitors,
      (SELECT COUNT(*) FROM dbo.Visits) AS allViews,
      (SELECT COUNT(*) FROM dbo.Bookings WHERE Kind = 'booking' AND ${inRange}) AS bookings,
      (SELECT COUNT(*) FROM dbo.Bookings WHERE Kind = 'consult' AND ${inRange}) AS consults,
      (SELECT COUNT(*) FROM dbo.Bookings WHERE Status = 'pending') AS pending,
      (SELECT COUNT(*) FROM dbo.Users WHERE Role = 'customer') AS customers`, p),
    query(`SELECT CONVERT(char(10), CreatedAt, 23) AS day, COUNT(*) AS views, COUNT(DISTINCT VisitorId) AS visitors
      FROM dbo.Visits WHERE ${inRange} GROUP BY CONVERT(char(10), CreatedAt, 23)`, p),
    query(`SELECT CONVERT(char(10), CreatedAt, 23) AS day, COUNT(*) AS n FROM dbo.Bookings WHERE ${inRange}
      GROUP BY CONVERT(char(10), CreatedAt, 23)`, p),
    query(`SELECT COALESCE(Device, 'desktop') AS device, COUNT(*) AS n FROM dbo.Visits WHERE ${inRange} GROUP BY Device ORDER BY n DESC`, p),
    query(`SELECT TOP 6 COALESCE(Referrer, N'Truy cập trực tiếp') AS ref, COUNT(*) AS n FROM dbo.Visits WHERE ${inRange}
      GROUP BY Referrer ORDER BY n DESC`, p),
    query(`SELECT TOP 5 Id AS id, Title AS title, COALESCE(ThumbUrl, ImageUrl) AS thumb, Views AS views FROM dbo.Designs
      WHERE Views > 0 ORDER BY Views DESC`),
  ]);
  const vmap = Object.fromEntries(series.map((r) => [r.day, r]));
  const bmap = Object.fromEntries(bookingSeries.map((r) => [r.day, r.n]));
  const filled = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    filled.push({ day: key, views: vmap[key]?.views || 0, visitors: vmap[key]?.visitors || 0, bookings: bmap[key] || 0 });
  }
  res.json({ days, totals, series: filled, devices, referrers, topDesigns });
}));

admin.get('/bookings', h(async (req, res) => {
  const where = [];
  const p = {};
  if (['pending', 'confirmed', 'done', 'cancelled'].includes(req.query.status)) { where.push('b.Status = @status'); p.status = req.query.status; }
  if (['booking', 'consult'].includes(req.query.type)) { where.push('b.Kind = @kind'); p.kind = req.query.type; }
  if (req.query.q) { where.push('(b.FullName LIKE @q OR b.Phone LIKE @q)'); p.q = `%${clean(req.query.q).slice(0, 60)}%`; }
  if (req.query.since) { where.push('b.Id > @since'); p.since = Number(req.query.since) || 0; }
  const sqlText = `${BOOKING_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.Id DESC OFFSET 0 ROWS FETCH NEXT 300 ROWS ONLY`;
  res.json({ bookings: await query(sqlText, p) });
}));

admin.patch('/bookings/:id', h(async (req, res) => {
  const status = req.body.status;
  if (!['pending', 'confirmed', 'done', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ.' });
  await query('UPDATE dbo.Bookings SET Status = @status WHERE Id = @id', { status, id: Number(req.params.id) });
  res.json({ ok: true });
}));

admin.delete('/bookings/:id', h(async (req, res) => {
  await query('DELETE FROM dbo.Bookings WHERE Id = @id', { id: Number(req.params.id) });
  res.json({ ok: true });
}));

admin.get('/customers', h(async (req, res) => {
  res.json({ customers: await query(`SELECT u.Id AS id, u.Email AS email, u.FullName AS name, u.Phone AS phone, u.Role AS role,
    u.CreatedAt AS created_at, (SELECT COUNT(*) FROM dbo.Bookings b WHERE b.UserId = u.Id) AS bookings
    FROM dbo.Users u ORDER BY u.Id DESC`) });
}));

admin.patch('/customers/:id', h(async (req, res) => {
  const id = Number(req.params.id);
  const role = req.body.role;
  if (!['admin', 'customer'].includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ.' });
  if (id === req.user.id) return res.status(400).json({ error: 'Bạn không thể tự đổi quyền của chính mình.' });
  await query('UPDATE dbo.Users SET Role = @role WHERE Id = @id', { role, id });
  if (role === 'customer') await query('DELETE FROM dbo.Sessions WHERE UserId = @id', { id }); // revoke admin sessions
  res.json({ ok: true });
}));

// ----- image upload: re-encoded to WebP (strips metadata, bounds size) -----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|avif)$/.test(file.mimetype)),
});

// Favicon: the logo on a rounded tile whose shade contrasts with the logo,
// so it stays visible on both light and dark browser tab bars.
async function makeFavicon(logo, out) {
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
  await sharp(bg)
    .composite([{ input: mark.data, raw: { width: mark.info.width, height: mark.info.height, channels: 4 }, left: PAD, top: PAD }])
    .png().toFile(out);
}

admin.post('/upload', upload.single('image'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chỉ nhận ảnh JPG, PNG, WEBP, AVIF tối đa 8MB.' });
  const base = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const img = sharp(req.file.buffer, { failOn: 'error' }).rotate();
    if (req.query.kind === 'logo') {
      // Logo keeps transparency; empty margins are trimmed so the mark fills its height.
      // A square PNG icon is derived for the browser tab.
      let logo = img;
      try {
        logo = sharp(await img.clone().trim({ threshold: 10 }).png().toBuffer());
      } catch { /* uniform image: nothing to trim */ }
      await logo.clone().resize({ width: 800, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90, alphaQuality: 100 })
        .toFile(path.join(UPLOAD_DIR, `${base}.webp`));
      await makeFavicon(logo, path.join(UPLOAD_DIR, `${base}-icon.png`));
      return res.json({ url: `/uploads/${base}.webp`, thumb: `/uploads/${base}.webp`, icon: `/uploads/${base}-icon.png` });
    }
    await img.clone().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 })
      .toFile(path.join(UPLOAD_DIR, `${base}.webp`));
    await img.clone().resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 })
      .toFile(path.join(UPLOAD_DIR, `${base}-sm.webp`));
  } catch {
    return res.status(400).json({ error: 'File ảnh bị lỗi hoặc không được hỗ trợ.' });
  }
  res.json({ url: `/uploads/${base}.webp`, thumb: `/uploads/${base}-sm.webp` });
}));

// ----- designs -----
admin.get('/designs', h(async (req, res) => {
  res.json({ designs: await query(`SELECT ${DESIGN_COLS} FROM dbo.Designs d ORDER BY d.Id DESC`) });
}));

const localImage = (v) => { const s = clean(v); return /^\/(uploads|images)\/[\w./-]+$/.test(s) && !s.includes('..') ? s : ''; };

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
  const r = await one(`INSERT INTO dbo.Designs(Title, Description, ImageUrl, ThumbUrl, CategoryId, ColorId, Price, IsFeatured, IsActive)
    OUTPUT INSERTED.Id AS id VALUES (@title, @description, @image, @thumb, @categoryId, @colorId, @price, @featured, @active)`, p);
  res.status(201).json(r);
}));

admin.put('/designs/:id', h(async (req, res) => {
  const { p, error } = designParams(req.body);
  if (error) return res.status(422).json({ error });
  await query(`UPDATE dbo.Designs SET Title=@title, Description=@description, ImageUrl=@image, ThumbUrl=@thumb, CategoryId=@categoryId,
    ColorId=@colorId, Price=@price, IsFeatured=@featured, IsActive=@active WHERE Id=@id`, { ...p, id: Number(req.params.id) });
  res.json({ ok: true });
}));

admin.delete('/designs/:id', h(async (req, res) => {
  await query('DELETE FROM dbo.Designs WHERE Id = @id', { id: Number(req.params.id) });
  res.json({ ok: true });
}));

// ----- colors / categories / services -----
function crud(route, table, map, validate, beforeDelete) {
  const cols = Object.keys(map);
  admin.post(`/${route}`, h(async (req, res) => {
    const e = validate(req.body); if (e) return res.status(422).json({ error: e });
    const p = Object.fromEntries(cols.map((c) => [c, map[c](req.body)]));
    res.status(201).json(await one(`INSERT INTO dbo.${table}(${cols.join(',')}) OUTPUT INSERTED.Id AS id VALUES (${cols.map((c) => '@' + c).join(',')})`, p));
  }));
  admin.put(`/${route}/:id`, h(async (req, res) => {
    const e = validate(req.body); if (e) return res.status(422).json({ error: e });
    const p = Object.fromEntries(cols.map((c) => [c, map[c](req.body)]));
    await query(`UPDATE dbo.${table} SET ${cols.map((c) => `${c}=@${c}`).join(',')} WHERE Id=@id`, { ...p, id: Number(req.params.id) });
    res.json({ ok: true });
  }));
  admin.delete(`/${route}/:id`, h(async (req, res) => {
    const id = Number(req.params.id);
    if (beforeDelete) await beforeDelete(id);
    await query(`DELETE FROM dbo.${table} WHERE Id = @id`, { id });
    res.json({ ok: true });
  }));
}
const text = (k, max) => (b) => clean(b[k]).slice(0, max) || null;
const int = (k) => (b) => Math.max(0, Math.round(Number(b[k]) || 0));
const flag = (k) => (b) => b[k] !== false && b[k] !== 0 && b[k] !== '0';

crud('colors', 'Colors',
  { Name: text('name', 40), Hex: (b) => clean(b.hex).toUpperCase(), Finish: (b) => (['gloss', 'matte', 'chrome', 'cateye'].includes(b.finish) ? b.finish : 'gloss'), SortOrder: int('sort') },
  (b) => (clean(b.name).length < 2 ? 'Tên màu tối thiểu 2 ký tự.' : !/^#[0-9a-f]{6}$/i.test(clean(b.hex)) ? 'Mã màu phải có dạng #RRGGBB.' : null),
  (id) => query('UPDATE dbo.Bookings SET ColorId = NULL WHERE ColorId = @id', { id }));
crud('categories', 'Categories',
  { Name: text('name', 40), SortOrder: int('sort') },
  (b) => (clean(b.name).length < 2 ? 'Tên danh mục tối thiểu 2 ký tự.' : null));
crud('services', 'Services',
  { Name: text('name', 80), Description: text('description', 300), PriceFrom: int('price_from'), DurationMin: int('duration'),
    ImageUrl: (b) => localImage(b.image) || null, SortOrder: int('sort'), IsActive: flag('active') },
  (b) => (clean(b.name).length < 2 ? 'Tên dịch vụ tối thiểu 2 ký tự.' : null));

admin.get('/services', h(async (req, res) => {
  res.json({ services: await query(`SELECT Id AS id, Name AS name, Description AS description, PriceFrom AS price_from,
    DurationMin AS duration, ImageUrl AS image, SortOrder AS sort, IsActive AS active FROM dbo.Services ORDER BY SortOrder, Id`) });
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
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three'), { maxAge: '7d' }));
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules/chart.js/dist'), { maxAge: '7d' }));
app.get(['/admin', '/admin/', '/admin/index.html'], (req, res, next) => {
  if (req.user?.role !== 'admin') return res.redirect('/?login=admin');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: 0 }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Ảnh vượt quá 8MB hoặc không hợp lệ.' });
  console.error(err);
  res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
});

db.init()
  .then(() => app.listen(PORT, () => console.log(`Nail studio: http://localhost:${PORT}   ·   Quản trị: http://localhost:${PORT}/admin`)))
  .catch((e) => {
    console.error('Không kết nối được SQL Server:', e.message);
    console.error('Kiểm tra file .env (DB_SERVER, DB_PORT, DB_USER, DB_PASSWORD) và đã chạy database/01_schema.sql.');
    process.exit(1);
  });
