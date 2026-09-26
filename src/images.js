// Uploaded images live in the database (free hosts such as Render have no persistent disk).
// They are served from /img/<id> with long-lived caching plus a small in-memory cache,
// so repeat views neither wake the database nor re-download.
const crypto = require('crypto');
const { query, one } = require('./db');

const CACHE_LIMIT = 48 * 1024 * 1024;
const cache = new Map(); // id → { type, data } in LRU order
let cacheBytes = 0;

function remember(id, entry) {
  if (entry.data.length > CACHE_LIMIT / 4) return;
  cache.delete(id);
  cache.set(id, entry);
  cacheBytes += entry.data.length;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_LIMIT) break;
    cache.delete(k);
    cacheBytes -= v.data.length;
  }
}

const TYPES = { webp: 'image/webp', png: 'image/png' };

async function saveImage(buffer, ext) {
  const id = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  await query('INSERT INTO images (id, content_type, data) VALUES (@id, @type, @data)', { id, type: TYPES[ext], data: buffer });
  remember(id, { type: TYPES[ext], data: buffer });
  return `/img/${id}`;
}

async function getImage(id) {
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const row = await one('SELECT content_type, data FROM images WHERE id = @id', { id });
  if (!row) return null;
  const entry = { type: row.content_type, data: row.data };
  remember(id, entry);
  return entry;
}

// Remove uploads nobody references any more (older than a day, so a file uploaded
// in a form that has not been saved yet is never touched).
async function purgeOrphans() {
  const rows = await query(`DELETE FROM images i
    WHERE i.created_at < now() - interval '1 day'
      AND NOT EXISTS (SELECT 1 FROM designs d WHERE d.image_url = '/img/' || i.id OR d.thumb_url = '/img/' || i.id)
      AND NOT EXISTS (SELECT 1 FROM services s WHERE s.image_url = '/img/' || i.id)
      AND NOT EXISTS (SELECT 1 FROM settings st WHERE st.setting_value LIKE '%' || i.id || '%')
    RETURNING i.id`);
  for (const r of rows) {
    const e = cache.get(r.id);
    if (e) { cache.delete(r.id); cacheBytes -= e.data.length; }
  }
  if (rows.length) console.log(`[images] removed ${rows.length} unused image(s)`);
}

module.exports = { saveImage, getImage, purgeOrphans };
