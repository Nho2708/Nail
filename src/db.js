// PostgreSQL access layer (driver: pg). Works with Neon, Supabase, Render/Railway Postgres or a local server.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');
const { hashPassword } = require('./security');

types.setTypeParser(20, (v) => parseInt(v, 10)); // COUNT(*) / bigint → number (values here are small)
types.setTypeParser(1082, (v) => v);             // DATE → 'YYYY-MM-DD' string, no timezone shifting

// Local wall-clock zone of the salon; used for "today" and per-day statistics.
const APP_TZ = /^[A-Za-z_]+\/[A-Za-z_+-]+$/.test(process.env.TZ || '') ? process.env.TZ : 'Asia/Ho_Chi_Minh';

if (!process.env.DATABASE_URL) {
  console.error('Thiếu biến môi trường DATABASE_URL (chuỗi kết nối PostgreSQL). Xem file .env.example.');
  process.exit(1);
}

const pool = new Pool({
  // Hosted Postgres URLs (Neon, Supabase…) say sslmode=require; pg already treats that as verify-full,
  // so say so explicitly — same security, no deprecation warning in the logs.
  connectionString: process.env.DATABASE_URL.replace(/sslmode=(require|prefer|verify-ca)\b/, 'sslmode=verify-full'),
  max: 5,
  // Close idle connections quickly so a serverless database (Neon) can scale to zero.
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 20_000, // first query after the DB slept may take a moment
});
pool.on('error', (e) => console.warn('[db] idle client error:', e.message));

// query(`SELECT … WHERE id = @id`, { id: 5 }) → rows. Named @params are turned into $1, $2 …
function toPositional(text, params = {}) {
  const values = [];
  const index = {};
  const sql = text.replace(/@([A-Za-z_]\w*)/g, (_, name) => {
    if (!(name in params)) throw new Error(`Missing SQL parameter @${name}`);
    if (!(name in index)) {
      values.push(params[name] === undefined ? null : params[name]);
      index[name] = values.length;
    }
    return `$${index[name]}`;
  });
  return { sql, values };
}

async function query(text, params, client) {
  const { sql, values } = toPositional(text, params);
  const r = await (client || pool).query(sql, values);
  return r.rows;
}
const one = async (text, params, client) => (await query(text, params, client))[0];

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- settings (defaults live in code, overrides in the settings table; cached in memory) ----------
const DEFAULT_SETTINGS = {
  brandName: 'Lumière Nail Studio',
  logoImage: '',
  logoIcon: '',
  logoHeight: '44',
  showBrandText: true,
  tagline: 'Móng đẹp. Sang trọng tinh tế.',
  siteTitle: '', // browser tab title; empty = "<brandName> · <tagline>"
  heroEyebrow: 'Nail Art Studio · Sài Gòn',
  heroTitle: 'Bộ móng được chăm chút như một tác phẩm',
  heroSubtitle: 'Thiết kế nail nghệ thuật và chăm sóc móng cao cấp. Chọn mẫu bạn thích, đặt lịch chỉ trong 30 giây.',
  heroImage: '/images/french-hong-nude.webp',
  aboutTitle: 'Hơn cả một bộ móng đẹp',
  aboutText: 'Chúng tôi xem việc làm móng là một nghi thức thư giãn: tay nghề tinh tế, sự chu đáo thật lòng và một không gian yên tĩnh để bạn được nghỉ ngơi.',
  aboutQuote: 'Đôi khi, những nghi thức nhỏ nhất lại mang đến khác biệt lớn nhất.',
  aboutImage: '/images/french-trang-sua.webp',
  servicesEyebrow: 'Dịch vụ',
  servicesTitle: 'Dịch vụ đặc trưng',
  servicesSubtitle: 'Bảng giá tham khảo. Nhấn vào ảnh để xem menu đầy đủ, hoặc chọn một dịch vụ để đặt lịch ngay.',
  servicesNote: '',
  servicesMenuImage: '',
  servicesMenuThumb: '',
  servicesImageSide: 'left',
  primaryColor: '#9D2B5B',
  accentColor: '#B08D57',
  bgColor: '#FBF7F4',
  textColor: '#2E1A24',
  headingFont: 'Playfair Display',
  bodyFont: 'Be Vietnam Pro',
  radius: '16',
  showAbout: true,
  showServices: true,
  showWhy: true,
  show3D: true,
  showProcess: true,
  phone: '',
  address: '',
  hours: '9:00 – 20:00, tất cả các ngày',
  openTime: '09:00',
  closeTime: '19:30',
  slotCapacity: '3',
  zaloPhone: '',
  messengerUsername: '',
  facebookUrl: '',
  instagramUrl: '',
  tiktokUrl: '',
  mapUrl: '',
  notifyTelegramToken: '',
  notifyTelegramChatId: '',
  notifyZaloOaToken: '',
  notifyZaloUserId: '',
  notifyMessengerPageToken: '',
  notifyMessengerPsid: '',
  notifyWebhookUrl: '',
};
const PRIVATE_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => k.startsWith('notify'));

// Refreshed at least every 10 minutes so changes made by another server sharing the DB show up.
const CACHE_TTL_MS = 10 * 60_000;
let settingsCache = null;
let settingsAt = 0;
async function getSettings({ includePrivate = false } = {}) {
  if (!settingsCache || Date.now() - settingsAt > CACHE_TTL_MS) {
    const rows = await query('SELECT setting_key, setting_value FROM settings');
    const out = { ...DEFAULT_SETTINGS };
    for (const r of rows) {
      if (!(r.setting_key in DEFAULT_SETTINGS)) continue;
      try { out[r.setting_key] = JSON.parse(r.setting_value); } catch { out[r.setting_key] = r.setting_value; }
    }
    settingsCache = out;
    settingsAt = Date.now();
  }
  const out = { ...settingsCache };
  if (!includePrivate) for (const k of PRIVATE_KEYS) delete out[k];
  return out;
}

async function saveSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[k];
    const val = typeof def === 'boolean' ? (v === true || v === 'true' || v === 1 || v === '1') : String(v ?? '').slice(0, 1500);
    await query(`INSERT INTO settings (setting_key, setting_value) VALUES (@k, @v)
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`, { k, v: JSON.stringify(val) });
  }
  settingsCache = null;
}

// Bootstrap only the first admin account. No sample data.
async function ensureAdmin() {
  if (await one("SELECT id FROM users WHERE role = 'admin' LIMIT 1")) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@nail.local').toLowerCase();
  let pass = process.env.ADMIN_PASSWORD;
  if (!pass) {
    // Never ship a guessable default: generate one and show it once in the logs.
    pass = 'Nail@' + crypto.randomBytes(6).toString('base64url') + '7';
    console.log(`[setup] Mật khẩu admin được tạo ngẫu nhiên: ${pass}`);
  }
  await query(`INSERT INTO users (email, password_hash, full_name, role) VALUES (@email, @hash, 'Quản trị viên', 'admin')`,
    { email, hash: hashPassword(pass) });
  console.log(`[setup] Đã tạo tài khoản admin: ${email} — hãy đổi mật khẩu sau khi đăng nhập.`);
}

async function init() {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  await ensureAdmin();
  await query('DELETE FROM sessions WHERE expires_at < now()');
}

module.exports = { CACHE_TTL_MS, pool, init, query, one, transaction, getSettings, saveSettings, DEFAULT_SETTINGS, PRIVATE_KEYS, APP_TZ };
