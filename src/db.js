// SQL Server 2019 access layer (driver: mssql/tedious).
const sql = require('mssql');
const { hashPassword } = require('./security');

// DB_SERVER accepts "HOST" or "HOST\INSTANCE" (e.g. QUANG-NHO\PRN222).
// With an instance name and no DB_PORT, the port is resolved through SQL Server Browser.
const [host, instance] = (process.env.DB_SERVER || 'localhost').split('\\');
const instanceName = process.env.DB_INSTANCE || instance;
const port = Number(process.env.DB_PORT) || (instanceName ? undefined : 1433);

const config = {
  server: host,
  ...(port ? { port } : {}),
  database: process.env.DB_NAME || 'NailStudio',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  options: {
    ...(!port && instanceName ? { instanceName } : {}),
    encrypt: process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: true,
    useUTC: false,
  },
};

let pool;
async function connect() {
  pool = await new sql.ConnectionPool(config).connect();
  return pool;
}

// query(`SELECT ... WHERE Id = @id`, { id: 5 }) -> rows
async function query(text, params = {}, tx) {
  const req = (tx || pool).request();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) req.input(k, sql.NVarChar, null);
    else if (typeof v === 'number' && Number.isInteger(v)) req.input(k, sql.Int, v);
    else if (typeof v === 'boolean') req.input(k, sql.Bit, v);
    else req.input(k, sql.NVarChar, String(v));
  }
  const r = await req.query(text);
  return r.recordset || [];
}
const one = async (text, params, tx) => (await query(text, params, tx))[0];

async function transaction(fn) {
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const out = await fn(tx);
    await tx.commit();
    return out;
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}

// ---------- settings (defaults live in code, overrides in dbo.Settings) ----------
const DEFAULT_SETTINGS = {
  brandName: 'Lumière Nail Studio',
  logoImage: '',
  logoIcon: '',
  logoHeight: '44',
  showBrandText: true,
  tagline: 'Móng đẹp. Sang trọng tinh tế.',
  heroEyebrow: 'Nail Art Studio · Sài Gòn',
  heroTitle: 'Bộ móng được chăm chút như một tác phẩm',
  heroSubtitle: 'Thiết kế nail nghệ thuật và chăm sóc móng cao cấp. Chọn mẫu bạn thích, đặt lịch chỉ trong 30 giây.',
  heroImage: '/images/french-hong-nude.webp',
  aboutTitle: 'Hơn cả một bộ móng đẹp',
  aboutText: 'Chúng tôi xem việc làm móng là một nghi thức thư giãn: tay nghề tinh tế, sự chu đáo thật lòng và một không gian yên tĩnh để bạn được nghỉ ngơi.',
  aboutQuote: 'Đôi khi, những nghi thức nhỏ nhất lại mang đến khác biệt lớn nhất.',
  aboutImage: '/images/french-trang-sua.webp',
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

async function getSettings({ includePrivate = false } = {}) {
  const rows = await query('SELECT SettingKey, SettingValue FROM dbo.Settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (!(r.SettingKey in DEFAULT_SETTINGS)) continue;
    try { out[r.SettingKey] = JSON.parse(r.SettingValue); } catch { out[r.SettingKey] = r.SettingValue; }
  }
  if (!includePrivate) for (const k of PRIVATE_KEYS) delete out[k];
  return out;
}

async function saveSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[k];
    const val = typeof def === 'boolean' ? (v === true || v === 'true' || v === 1 || v === '1') : String(v ?? '').slice(0, 1500);
    await query(`UPDATE dbo.Settings SET SettingValue = @v WHERE SettingKey = @k;
      IF @@ROWCOUNT = 0 INSERT INTO dbo.Settings(SettingKey, SettingValue) VALUES (@k, @v);`, { k, v: JSON.stringify(val) });
  }
}

// Bootstrap only the first admin account (credentials from .env). No sample data.
async function ensureAdmin() {
  const hasAdmin = await one("SELECT TOP 1 Id FROM dbo.Users WHERE Role = 'admin'");
  if (hasAdmin) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@nail.local').toLowerCase();
  const pass = process.env.ADMIN_PASSWORD || 'Admin@123';
  await query(`INSERT INTO dbo.Users(Email, PasswordHash, FullName, Role) VALUES (@email, @hash, N'Quản trị viên', 'admin')`,
    { email, hash: hashPassword(pass) });
  console.log(`[setup] Đã tạo tài khoản admin: ${email} (mật khẩu trong .env — hãy đổi sau khi đăng nhập)`);
}

async function init() {
  await connect();
  await ensureAdmin();
  await query('DELETE FROM dbo.Sessions WHERE ExpiresAt < SYSDATETIME()');
}

module.exports = { sql, init, query, one, transaction, getSettings, saveSettings, DEFAULT_SETTINGS, PRIVATE_KEYS };
