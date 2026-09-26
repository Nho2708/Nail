// Page views are buffered in memory and written in batches. Every write wakes a
// serverless database (Neon suspends after 5 idle minutes), so batching keeps the
// monthly compute allowance for real work such as bookings.
const { query } = require('./db');

const FLUSH_EVERY_MS = 30 * 60_000;
const FLUSH_AT = 200;
const MAX_BUFFER = 5000;

let visits = [];
let designViews = new Map();
let flushing = null;

function recordVisit({ visitor, path, referrer, device }) {
  if (visits.length >= MAX_BUFFER) visits.shift();
  visits.push({ visitor, path, referrer: referrer || null, device, at: new Date() });
  if (visits.length >= FLUSH_AT) flush();
}

function recordDesignView(id) {
  designViews.set(id, (designViews.get(id) || 0) + 1);
}

async function flush() {
  if (flushing) return flushing;
  if (!visits.length && !designViews.size) return;
  const rows = visits;
  const views = designViews;
  visits = [];
  designViews = new Map();
  flushing = (async () => {
    try {
      if (rows.length) {
        await query(`INSERT INTO visits (visitor_id, path, referrer, device, created_at)
          SELECT * FROM unnest(@v::text[], @p::text[], @r::text[], @d::text[], @t::timestamptz[])`, {
          v: rows.map((x) => x.visitor), p: rows.map((x) => x.path), r: rows.map((x) => x.referrer),
          d: rows.map((x) => x.device), t: rows.map((x) => x.at),
        });
      }
      if (views.size) {
        await query(`UPDATE designs d SET views = d.views + v.n
          FROM unnest(@ids::int[], @ns::int[]) AS v(id, n) WHERE d.id = v.id`, { ids: [...views.keys()], ns: [...views.values()] });
      }
    } catch (e) {
      console.warn('[analytics] flush failed, will retry:', e.message);
      visits = rows.concat(visits).slice(-MAX_BUFFER);
      for (const [id, n] of views) designViews.set(id, (designViews.get(id) || 0) + n);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

setInterval(flush, FLUSH_EVERY_MS).unref();

module.exports = { recordVisit, recordDesignView, flush };
