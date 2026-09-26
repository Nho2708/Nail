import { api, esc, vnd, $, $$, icon, hydrateIcons, toast, fmtDate, fmtDateTime, setFieldError, STATUS, FONT_OPTIONS, applyTheme, tabTitle } from '/js/common.js';

const VIEWS = {
  dashboard: { title: 'Thống kê truy cập', render: renderDashboard },
  bookings: { title: 'Lịch hẹn & tư vấn', render: renderBookings },
  designs: { title: 'Mẫu nail', render: renderDesigns },
  colors: { title: 'Màu sơn', render: renderColors },
  categories: { title: 'Danh mục mẫu', render: renderCategories },
  services: { title: 'Dịch vụ', render: renderServices },
  customers: { title: 'Khách hàng & phân quyền', render: renderCustomers },
  appearance: { title: 'Thiết kế giao diện', render: renderAppearance },
  notify: { title: 'Thông báo Zalo / Messenger', render: renderNotify },
  account: { title: 'Tài khoản admin', render: renderAccount },
};
const FINISH = { gloss: 'Bóng', matte: 'Lì', chrome: 'Tráng gương', cateye: 'Mắt mèo' };
const SERIES = { views: '#9D2B5B', visitors: '#2A78D6' }; // validated pair (dataviz validator: all checks pass)

let me = null;
let settings = {};
let lastBookingId = 0;
let charts = [];
const view = $('#view');

hydrateIcons();
boot();

async function boot() {
  try {
    [{ user: me }, settings] = await Promise.all([api('/api/auth/me'), api('/api/admin/settings')]);
  } catch (e) {
    if (e.status === 401 || e.status === 403) { location.href = '/?login=admin'; return; }
    toast(e.message, 'error');
    return;
  }
  applyTheme({ ...settings, bgColor: '#F7F4F2' });
  renderSideBrand();
  $('#who').textContent = me.name;
  window.addEventListener('hashchange', route);
  route();
  pollBookings(true);
  // Poll only while the tab is visible: every request wakes the (serverless) database.
  setInterval(() => { if (!document.hidden) pollBookings(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollBookings(); });
  wireShell();
}

function renderSideBrand() {
  $('#side-brand').textContent = settings.brandName;
  const logo = $('#side-logo');
  logo.hidden = !settings.logoImage;
  $('#side-mark').hidden = !!settings.logoImage;
  if (settings.logoImage) logo.src = settings.logoImage;
  // Browser tab: brand logo as favicon, brand name in the title.
  const fav = $('#favicon');
  fav.dataset.default ||= fav.href;
  fav.href = settings.logoIcon || settings.logoImage || fav.dataset.default;
  setTitle();
}

function setTitle() {
  document.title = tabTitle(settings) || 'Quản trị';
}

function wireShell() {
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.href = '/'; };
  const sb = $('#sidebar');
  const scrim = $('#side-scrim');
  const setMenu = (open) => { sb.classList.toggle('open', open); scrim.hidden = !open; $('#menu-btn').setAttribute('aria-expanded', String(open)); };
  $('#menu-btn').onclick = () => setMenu(!sb.classList.contains('open'));
  scrim.onclick = () => setMenu(false);
  $('#side-nav').addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  const nb = $('#notif-btn');
  const refreshBell = () => { nb.style.color = 'Notification' in window && Notification.permission === 'granted' ? 'var(--success)' : ''; };
  refreshBell();
  nb.onclick = async () => {
    if (!('Notification' in window)) return toast('Trình duyệt không hỗ trợ thông báo.', 'error');
    const p = await Notification.requestPermission();
    refreshBell();
    toast(p === 'granted' ? 'Đã bật thông báo khi có lịch hẹn mới.' : 'Bạn chưa cho phép thông báo.', p === 'granted' ? 'success' : 'info');
  };
  const dlg = $('#editor');
  for (const b of $$('[data-close]', dlg)) b.onclick = () => dlg.close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => document.body.classList.remove('modal-open'));
}

function route() {
  const key = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
  for (const a of $$('#side-nav a')) {
    if (a.dataset.view === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  $('#view-title').textContent = VIEWS[key].title;
  setTitle();
  charts.forEach((c) => c.destroy());
  charts = [];
  view.innerHTML = '<div class="skeleton" style="height:240px"></div>';
  VIEWS[key].render().catch((e) => {
    view.innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
    if (e.status === 401 || e.status === 403) location.href = '/?login=admin';
  });
  view.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- polling
async function pollBookings(initial = false) {
  try {
    const { bookings } = await api(`/api/admin/bookings?since=${lastBookingId}`);
    const pending = await api('/api/admin/bookings?status=pending');
    const n = pending.bookings.length;
    const badge = $('#pending-count');
    badge.hidden = !n;
    badge.textContent = n;
    if (!bookings.length) return;
    const maxId = Math.max(...bookings.map((b) => b.id));
    if (!initial && lastBookingId) {
      for (const b of bookings.reverse()) {
        const msg = `${b.type === 'consult' ? 'Yêu cầu tư vấn' : 'Lịch hẹn'} mới từ ${b.name}${b.date ? ` — ${b.time} ${fmtDate(b.date)}` : ''}`;
        toast(msg, 'success', 7000);
        if ('Notification' in window && Notification.permission === 'granted') new Notification('Nail Studio', { body: msg, tag: `bk-${b.id}` });
      }
      if (location.hash === '#bookings') renderBookings(true);
    }
    lastBookingId = maxId;
  } catch { /* offline: try again next tick */ }
}

// ---------------------------------------------------------------- dashboard
let statDays = 14;
async function renderDashboard() {
  const s = await api(`/api/admin/stats?days=${statDays}`);
  const t = s.totals;
  const kpi = (lbl, val, sub = '', cls = '', ic = '') => `<div class="kpi ${cls}"><div class="lbl">${ic ? icon(ic, 16) : ''}${lbl}</div><div class="val">${Number(val).toLocaleString('vi-VN')}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  view.innerHTML = `
    <div class="toolbar"><div class="range" role="group" aria-label="Khoảng thời gian">
      ${[7, 14, 30, 90].map((d) => `<button data-days="${d}" aria-pressed="${d === statDays}">${d} ngày</button>`).join('')}
    </div><span class="spacer"></span><button class="btn btn-ghost btn-sm" id="refresh">${icon('refresh', 16)}Làm mới</button></div>
    <div class="kpis">
      ${kpi('Lượt xem hôm nay', t.today, `${t.todayVisitors.toLocaleString('vi-VN')} khách truy cập`, '', 'eye')}
      ${kpi(`Lượt xem ${statDays} ngày`, t.views, `Tổng từ trước tới nay: ${t.allViews.toLocaleString('vi-VN')}`, '', 'dashboard')}
      ${kpi(`Khách truy cập ${statDays} ngày`, t.visitors, 'Đếm theo thiết bị/trình duyệt', '', 'users')}
      ${kpi('Chờ xác nhận', t.pending, '<a href="#bookings" style="color:inherit">Xem lịch hẹn →</a>', 'accent', 'calendar')}
      ${kpi(`Lịch hẹn ${statDays} ngày`, t.bookings, `${t.consults} yêu cầu tư vấn`, '', 'calendar')}
      ${kpi('Khách hàng đăng ký', t.customers, '', '', 'user')}
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><div><h2>Lượt truy cập theo ngày</h2><p>Lượt xem trang và số khách truy cập duy nhất</p></div>
          <div class="legend"><span><i style="--c:${SERIES.views}"></i>Lượt xem</span><span><i style="--c:${SERIES.visitors}"></i>Khách truy cập</span></div></div>
        <div class="chart-box"><canvas id="c-visits" role="img" aria-label="Biểu đồ lượt xem và khách truy cập theo ngày"></canvas></div>
        <details style="margin-top:12px"><summary class="muted" style="cursor:pointer;font-size:13px">Xem dạng bảng</summary>
          <div class="table-wrap" style="margin-top:8px;max-height:260px;overflow:auto"><table><thead><tr><th>Ngày</th><th>Lượt xem</th><th>Khách</th><th>Lịch mới</th></tr></thead>
          <tbody>${s.series.slice().reverse().map((r) => `<tr><td>${fmtDate(r.day)}</td><td>${r.views}</td><td>${r.visitors}</td><td>${r.bookings}</td></tr>`).join('')}</tbody></table></div></details>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Lịch hẹn mới theo ngày</h2><p>Gồm cả yêu cầu tư vấn</p></div></div>
        <div class="chart-box"><canvas id="c-bookings" role="img" aria-label="Biểu đồ số lịch hẹn mới theo ngày"></canvas></div>
      </section>
    </div>
    <div class="grid-3">
      <section class="card"><div class="card-head"><h2>Thiết bị</h2></div>${barsHtml(s.devices.map((d) => [({ mobile: 'Điện thoại', desktop: 'Máy tính', tablet: 'Máy tính bảng' })[d.device] || d.device, d.n]))}</section>
      <section class="card"><div class="card-head"><h2>Nguồn truy cập</h2></div>${barsHtml(s.referrers.map((r) => [r.ref, r.n]))}</section>
      <section class="card"><div class="card-head"><h2>Mẫu được xem nhiều</h2></div>
        ${s.topDesigns.length ? `<div class="top-list">${s.topDesigns.map((d) => `<div class="top-item"><img src="${esc(d.thumb)}" alt=""><span class="t">${esc(d.title)}</span><span class="muted">${d.views} lượt</span></div>`).join('')}</div>` : '<p class="muted">Chưa có dữ liệu.</p>'}
      </section>
    </div>`;
  $$('[data-days]').forEach((b) => (b.onclick = () => { statDays = Number(b.dataset.days); route(); }));
  $('#refresh').onclick = () => route();
  await drawCharts(s.series);
}

function barsHtml(rows) {
  if (!rows.length) return '<p class="muted">Chưa có dữ liệu.</p>';
  const max = Math.max(...rows.map((r) => r[1]));
  return `<div class="bars">${rows.map(([k, n]) => `<div class="bar-row"><span>${esc(k)}</span><span class="n">${n.toLocaleString('vi-VN')}</span><div class="track"><div class="fill" style="width:${(n / max) * 100}%"></div></div></div>`).join('')}</div>`;
}

let chartLib;
function loadChartLib() {
  chartLib ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/chart.js/chart.umd.min.js';
    s.onload = () => resolve(window.Chart);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return chartLib;
}

async function drawCharts(series) {
  const Chart = await loadChartLib();
  const labels = series.map((r) => fmtDate(r.day).slice(0, 5));
  const ink = '#6B5A62';
  const grid = 'rgba(46,26,36,.07)';
  const font = { family: getComputedStyle(document.body).fontFamily, size: 12 };
  const base = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: '#2E1A24', titleFont: font, bodyFont: font, padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: ink, font, maxRotation: 0, autoSkipPadding: 12 }, border: { color: grid } },
      y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: ink, font, precision: 0 } },
    },
  };
  const line = (label, key, color) => ({
    label, data: series.map((r) => r[key]), borderColor: color, backgroundColor: color, borderWidth: 2,
    pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: '#fff', tension: 0.3,
  });
  charts.push(new Chart($('#c-visits'), {
    type: 'line',
    data: { labels, datasets: [line('Lượt xem', 'views', SERIES.views), line('Khách truy cập', 'visitors', SERIES.visitors)] },
    options: base,
  }));
  charts.push(new Chart($('#c-bookings'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Lịch mới', data: series.map((r) => r.bookings), backgroundColor: SERIES.views, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', maxBarThickness: 18 }] },
    options: base,
  }));
}

// ---------------------------------------------------------------- bookings
const bkFilter = { q: '', status: '', type: '' };
async function renderBookings(highlightNew = false) {
  const qs = new URLSearchParams(Object.entries(bkFilter).filter(([, v]) => v)).toString();
  const { bookings } = await api(`/api/admin/bookings?${qs}`);
  const prevIds = new Set($$('tr[data-id]', view).map((r) => Number(r.dataset.id)));
  const exists = $('#bk-table', view);
  if (!exists) {
    view.innerHTML = `
      <div class="toolbar">
        <label class="search"><span class="sr-only">Tìm theo tên hoặc số điện thoại</span>${icon('search', 16)}<input type="search" id="bk-q" placeholder="Tìm tên hoặc SĐT…" value="${esc(bkFilter.q)}"></label>
        <label><span class="sr-only">Trạng thái</span><select id="bk-status"><option value="">Mọi trạng thái</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${bkFilter.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
        <label><span class="sr-only">Loại</span><select id="bk-type"><option value="">Đặt lịch & tư vấn</option><option value="booking" ${bkFilter.type === 'booking' ? 'selected' : ''}>Chỉ đặt lịch</option><option value="consult" ${bkFilter.type === 'consult' ? 'selected' : ''}>Chỉ tư vấn</option></select></label>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" id="bk-csv">${icon('upload', 16)}Xuất CSV</button>
        <button class="btn btn-ghost btn-sm" id="bk-refresh">${icon('refresh', 16)}Làm mới</button>
      </div>
      <div class="table-wrap"><table id="bk-table"><thead><tr>
        <th>#</th><th>Khách hàng</th><th>Loại</th><th>Thời gian hẹn</th><th>Yêu cầu</th><th>Ghi chú</th><th>Trạng thái</th><th>Báo admin</th><th><span class="sr-only">Thao tác</span></th>
      </tr></thead><tbody></tbody></table></div>`;
    let tmr;
    $('#bk-q').oninput = (e) => { clearTimeout(tmr); tmr = setTimeout(() => { bkFilter.q = e.target.value.trim(); renderBookings(); }, 300); };
    $('#bk-status').onchange = (e) => { bkFilter.status = e.target.value; renderBookings(); };
    $('#bk-type').onchange = (e) => { bkFilter.type = e.target.value; renderBookings(); };
    $('#bk-refresh').onclick = () => renderBookings();
    $('#bk-table').addEventListener('change', onBookingStatus);
    $('#bk-table').addEventListener('click', onBookingDelete);
  }
  $('#bk-csv').onclick = () => exportCsv(bookings);
  const tbody = $('#bk-table tbody');
  if (!bookings.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:40px">Chưa có lịch hẹn nào${qs ? ' phù hợp bộ lọc' : ''}.</td></tr>`;
    return;
  }
  tbody.innerHTML = bookings.map((b) => {
    const notified = safeJson(b.notified);
    const nb = notified ? Object.entries(notified).filter(([, v]) => v !== 'skipped')
      .map(([k, v]) => `<span class="${v === 'ok' ? 'ok' : 'err'}" title="${esc(v)}">${esc({ telegram: 'Tele', zalo: 'Zalo', messenger: 'Mess', webhook: 'Hook' }[k])}</span>`).join('') : '';
    const phone = b.phone.replace(/\D/g, '');
    return `<tr data-id="${b.id}" class="${highlightNew && prevIds.size && !prevIds.has(b.id) ? 'new-row' : ''}">
      <td class="small">${b.id}</td>
      <td><div class="strong">${esc(b.name)}</div><div class="small"><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a> · <a href="https://zalo.me/${esc(phone)}" target="_blank" rel="noopener">Zalo</a>${b.user_id ? ' · <span title="Khách có tài khoản">Thành viên</span>' : ''}</div>${b.email ? `<div class="small">${esc(b.email)}</div>` : ''}</td>
      <td><span class="kind ${b.type}">${b.type === 'consult' ? 'Tư vấn' : 'Đặt lịch'}</span></td>
      <td>${b.date ? `<div class="strong">${esc(b.time)}</div><div class="small">${fmtDate(b.date)}</div>` : '<span class="small">—</span>'}<div class="small">Gửi: ${fmtDateTime(b.created_at)}</div></td>
      <td>${b.design_thumb ? `<div class="chipsw"><img class="thumb" src="${esc(b.design_thumb)}" alt=""><span>${esc(b.design_title)}</span></div>` : ''}
        ${b.service_name ? `<div class="small">${esc(b.service_name)}</div>` : ''}
        ${b.color_name || b.custom_color ? `<div class="small chipsw"><span class="dot" style="--c:${esc(b.color_hex || b.custom_color)}"></span>${esc(b.color_name || b.custom_color)}</div>` : ''}</td>
      <td class="small" style="max-width:220px">${esc(b.note || '')}</td>
      <td><label><span class="sr-only">Trạng thái lịch #${b.id}</span><select class="status-select ${STATUS[b.status].cls}" data-status="${b.id}">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === b.status ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label></td>
      <td><span class="notif-ic">${nb || '<span class="small muted">Chưa cấu hình</span>'}</span></td>
      <td><div class="row-actions"><button class="icon-btn danger" data-del="${b.id}" aria-label="Xóa lịch #${b.id}">${icon('trash', 18)}</button></div></td>
    </tr>`;
  }).join('');
}
const safeJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

async function onBookingStatus(e) {
  const sel = e.target.closest('[data-status]');
  if (!sel) return;
  try {
    await api(`/api/admin/bookings/${sel.dataset.status}`, { method: 'PATCH', body: { status: sel.value } });
    sel.className = `status-select ${STATUS[sel.value].cls}`;
    toast(`Đã cập nhật: ${STATUS[sel.value].label}`, 'success');
    pollBookings();
  } catch (err) { toast(err.message, 'error'); }
}
async function onBookingDelete(e) {
  const b = e.target.closest('[data-del]');
  if (!b || !confirm(`Xóa vĩnh viễn lịch #${b.dataset.del}?`)) return;
  try {
    await api(`/api/admin/bookings/${b.dataset.del}`, { method: 'DELETE' });
    b.closest('tr').remove();
    toast('Đã xóa.', 'success');
    pollBookings();
  } catch (err) { toast(err.message, 'error'); }
}
function exportCsv(rows) {
  const head = ['Mã', 'Loại', 'Họ tên', 'SĐT', 'Email', 'Ngày', 'Giờ', 'Dịch vụ', 'Mẫu', 'Màu', 'Ghi chú', 'Trạng thái', 'Thời điểm gửi'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((b) => [b.id, b.type === 'consult' ? 'Tư vấn' : 'Đặt lịch', b.name, b.phone, b.email, b.date && fmtDate(b.date), b.time, b.service_name, b.design_title, b.color_name || b.custom_color, b.note, STATUS[b.status].label, fmtDateTime(b.created_at)].map(cell).join(','));
  const blob = new Blob(['﻿' + [head.map(cell).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `lich-hen-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- generic editor
function openEditor({ title, fields, values = {}, submitLabel = 'Lưu', onSubmit }) {
  const dlg = $('#editor');
  const form = $('#editor-form');
  $('#editor-title').textContent = title;
  form.innerHTML = fields.map((f) => fieldHtml(f, values[f.name])).join('') +
    `<div class="form-error" role="alert" hidden></div><div class="modal-actions"><button type="button" class="btn btn-ghost" data-cancel>Hủy</button><button class="btn btn-primary" type="submit">${esc(submitLabel)}</button></div>`;
  $('[data-cancel]', form).onclick = () => dlg.close();
  for (const up of $$('[data-upload]', form)) wireUpload(up);
  for (const cf of $$('.color-field', form)) {
    const [picker, text] = $$('input', cf);
    picker.oninput = () => { text.value = picker.value.toUpperCase(); };
    text.oninput = () => { if (/^#[0-9a-f]{6}$/i.test(text.value)) picker.value = text.value; };
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.hidden = true;
    let first = null;
    for (const f of fields) {
      const input = form.elements[f.name];
      if (!input || f.type === 'checkbox') continue;
      const v = String(input.value || '').trim();
      let msg = '';
      if (f.required && !v) msg = f.type === 'image' ? 'Vui lòng tải ảnh lên.' : 'Vui lòng điền thông tin này.';
      else if (f.min && v && v.length < f.min) msg = `Tối thiểu ${f.min} ký tự.`;
      else if (f.type === 'color' && v && !/^#[0-9a-f]{6}$/i.test(v)) msg = 'Mã màu phải có dạng #RRGGBB.';
      else if (f.type === 'number' && v && (isNaN(v) || Number(v) < 0)) msg = 'Phải là số không âm.';
      const target = f.type === 'image' ? $(`[data-upload="${f.name}"] input[type=file]`, form) : input;
      setFieldError(target, msg);
      if (msg && !first) first = target;
    }
    if (first) { first.focus(); return; }
    const data = {};
    for (const f of fields) {
      const input = form.elements[f.name];
      data[f.name] = f.type === 'checkbox' ? input.checked : f.type === 'number' ? Number(input.value || 0) : input.value.trim();
      if (f.type === 'image') data[f.name + '_thumb'] = form.elements[f.name].dataset.thumb || '';
    }
    const btn = $('button[type=submit]', form);
    btn.classList.add('loading');
    try {
      await onSubmit(data);
      dlg.close();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally { btn.classList.remove('loading'); }
  };
  dlg.showModal();
  document.body.classList.add('modal-open');
  $('input:not([type=hidden]):not([type=file]), select, textarea', form)?.focus();
}

function fieldHtml(f, v) {
  const id = `ed-${f.name}`;
  const req = f.required ? ' <span class="req" aria-hidden="true">*</span>' : '';
  const hint = f.hint ? `<p class="hint">${f.hint}</p>` : '';
  const val = v ?? f.default ?? '';
  switch (f.type) {
    case 'textarea': return `<div class="field"><label for="${id}">${f.label}${req}</label><textarea id="${id}" name="${f.name}" rows="3" maxlength="${f.max || 500}">${esc(val)}</textarea>${hint}</div>`;
    case 'select': return `<div class="field"><label for="${id}">${f.label}${req}</label><select id="${id}" name="${f.name}">${f.options.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${hint}</div>`;
    case 'checkbox': return `<label class="check"><input type="checkbox" name="${f.name}" ${val === true || val === 1 || (val === '' && f.default) ? 'checked' : ''}>${f.label}</label>`;
    case 'color': return `<div class="field"><label for="${id}">${f.label}${req}</label><div class="color-field"><input type="color" value="${esc(val || '#E9B8B0')}" aria-label="Chọn màu"><input id="${id}" name="${f.name}" value="${esc((val || '#E9B8B0').toUpperCase())}" maxlength="7" spellcheck="false"></div>${hint}</div>`;
    case 'image': return `<div class="field"><span class="label">${f.label}${req}</span>
      <div class="upload" data-upload="${f.name}">
        <div class="upload-preview">${val ? `<img src="${esc(val)}" alt="">` : icon('image', 28)}</div>
        <div><span class="btn btn-ghost btn-sm upload-btn">${icon('upload', 16)}${val ? 'Đổi ảnh' : 'Tải ảnh lên'}<input type="file" accept="image/jpeg,image/png,image/webp,image/avif" aria-label="${esc(f.label)}"></span>
        <p class="hint">JPG, PNG, WEBP tối đa 8MB. Ảnh được tự động tối ưu.</p></div>
        <input type="hidden" name="${f.name}" value="${esc(val)}" data-thumb="${esc(f.thumb || '')}">
      </div></div>`;
    default: return `<div class="field"><label for="${id}">${f.label}${req}</label><input id="${id}" name="${f.name}" type="${f.type === 'number' ? 'number' : 'text'}" ${f.type === 'number' ? `min="0" step="${f.step || 1000}" inputmode="numeric"` : ''} value="${esc(val)}" maxlength="${f.max || 120}" ${f.suggest?.length ? `list="${id}-list" autocomplete="off"` : ''}>${f.suggest?.length ? `<datalist id="${id}-list">${f.suggest.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>` : ''}${hint}</div>`;
  }
}

function wireUpload(box, onDone) {
  const file = $('input[type=file]', box);
  const hidden = $('input[type=hidden]:not([data-from])', box);
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { setFieldError(file, 'Ảnh vượt quá 8MB.'); return; }
    const prev = $('.upload-preview', box);
    prev.innerHTML = '<div class="skeleton" style="width:100%;height:100%"></div>';
    const form = new FormData();
    form.append('image', f);
    try {
      const res = await api(`/api/admin/upload${box.dataset.kind ? `?kind=${box.dataset.kind}` : ''}`, { method: 'POST', form });
      hidden.value = res.url;
      hidden.dataset.thumb = res.thumb;
      for (const extra of $$('input[type=hidden][data-from]', box)) extra.value = res[extra.dataset.from] || '';
      prev.innerHTML = `<img src="${esc(res.thumb)}" alt="">`;
      setFieldError(file, '');
      $('[data-clear]', box)?.removeAttribute('hidden');
      const label = $('[data-after]', box);
      if (label) label.textContent = label.dataset.after;
      onDone?.(res);
    } catch (e) {
      prev.innerHTML = icon('image', 28);
      setFieldError(file, e.message);
    }
    file.value = '';
  };
}

// ---------------------------------------------------------------- designs
async function renderDesigns() {
  const [{ designs }, cat] = await Promise.all([api('/api/admin/designs'), api('/api/catalog')]);
  const catName = Object.fromEntries(cat.categories.map((c) => [c.id, c.name]));
  const colorOf = Object.fromEntries(cat.colors.map((c) => [c.id, c]));
  view.innerHTML = `
    <div class="toolbar"><p class="muted">${designs.length} mẫu · Mẫu "nổi bật" hiển thị đầu tiên và trên ảnh hero.</p><span class="spacer"></span>
      <button class="btn btn-primary" id="add">${icon('plus', 18)}Thêm mẫu nail</button></div>
    ${designs.length ? `<div class="admin-grid">${designs.map((d) => `
      <article class="admin-card">
        <div class="media"><img src="${esc(d.thumb)}" alt="" loading="lazy"><div class="flags">${d.featured ? '<span>Nổi bật</span>' : ''}${d.active ? '' : '<span class="off">Đang ẩn</span>'}</div></div>
        <div class="body"><strong>${esc(d.title)}</strong><small>${esc(catName[d.category_id] || 'Chưa phân loại')}${colorOf[d.color_id] ? ` · <span class="dot" style="--c:${esc(colorOf[d.color_id].hex)}"></span> ${esc(colorOf[d.color_id].name)}` : ''}</small><small>${vnd(d.price)}</small></div>
        <div class="foot"><span>${icon('eye', 14)} ${d.views} lượt xem</span><div class="row-actions">
          <button class="icon-btn" data-edit="${d.id}" aria-label="Sửa ${esc(d.title)}">${icon('pencil', 18)}</button>
          <button class="icon-btn danger" data-del="${d.id}" aria-label="Xóa ${esc(d.title)}">${icon('trash', 18)}</button></div></div>
      </article>`).join('')}</div>`
    : emptyState('image', 'Chưa có mẫu nail nào', 'Thêm mẫu đầu tiên để khách hàng có thể xem và đặt lịch. Nên tạo danh mục và màu sơn trước.')}`;
  const fields = [
    { name: 'image', label: 'Ảnh mẫu', type: 'image', required: true },
    { name: 'title', label: 'Tên mẫu', required: true, min: 2, max: 80 },
    { name: 'description', label: 'Mô tả', type: 'textarea' },
    { name: 'category_id', label: 'Danh mục', type: 'select', options: [['', '— Không —'], ...cat.categories.map((c) => [c.id, c.name])], hint: cat.categories.length ? '' : 'Chưa có danh mục — tạo ở mục "Danh mục mẫu".' },
    { name: 'color_id', label: 'Màu chủ đạo', type: 'select', options: [['', '— Không —'], ...cat.colors.map((c) => [c.id, c.name])], hint: cat.colors.length ? '' : 'Chưa có màu — tạo ở mục "Màu sơn".' },
    { name: 'price', label: 'Giá tham khảo (VNĐ)', type: 'number', hint: 'Để 0 nếu muốn hiển thị "Liên hệ".' },
    { name: 'featured', label: 'Đánh dấu mẫu nổi bật', type: 'checkbox' },
    { name: 'active', label: 'Hiển thị trên trang khách', type: 'checkbox', default: true },
  ];
  const save = (id) => async (data) => {
    const body = { ...data, thumb: data.image_thumb || undefined };
    if (id) {
      const old = designs.find((d) => d.id === id);
      if (!data.image_thumb && data.image === old.image) body.thumb = old.thumb;
    }
    await api(id ? `/api/admin/designs/${id}` : '/api/admin/designs', { method: id ? 'PUT' : 'POST', body });
    toast(id ? 'Đã cập nhật mẫu.' : 'Đã thêm mẫu mới.', 'success');
    renderDesigns();
  };
  $('#add').onclick = () => openEditor({ title: 'Thêm mẫu nail', fields, onSubmit: save(null) });
  view.onclick = async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) {
      const d = designs.find((x) => x.id === Number(ed.dataset.edit));
      openEditor({ title: 'Sửa mẫu nail', fields, values: { ...d, featured: !!d.featured, active: !!d.active, category_id: d.category_id ?? '', color_id: d.color_id ?? '' }, onSubmit: save(d.id) });
    }
    const del = e.target.closest('[data-del]');
    if (del && confirm('Xóa mẫu này? Lịch hẹn cũ vẫn được giữ lại.')) {
      await api(`/api/admin/designs/${del.dataset.del}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
      renderDesigns();
    }
  };
}

function emptyState(ic, title, text) {
  return `<div class="empty">${icon(ic, 40)}<h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
}

// ---------------------------------------------------------------- simple lookup tables
function simpleTable({ rows, columns, addLabel, emptyTitle, emptyText, fields, endpoint, reload, toValues = (r) => r }) {
  view.innerHTML = `
    <div class="toolbar"><p class="muted">${rows.length} mục</p><span class="spacer"></span><button class="btn btn-primary" id="add">${icon('plus', 18)}${addLabel}</button></div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th>${c[0]}</th>`).join('')}<th><span class="sr-only">Thao tác</span></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td>${c[1](r)}</td>`).join('')}<td><div class="row-actions">
        <button class="icon-btn" data-edit="${r.id}" aria-label="Sửa">${icon('pencil', 18)}</button>
        <button class="icon-btn danger" data-del="${r.id}" aria-label="Xóa">${icon('trash', 18)}</button></div></td></tr>`).join('')}</tbody></table></div>`
    : emptyState('plus', emptyTitle, emptyText)}`;
  const save = (id) => async (data) => {
    await api(id ? `${endpoint}/${id}` : endpoint, { method: id ? 'PUT' : 'POST', body: data });
    toast('Đã lưu.', 'success');
    reload();
  };
  $('#add').onclick = () => openEditor({ title: addLabel, fields, onSubmit: save(null) });
  view.onclick = async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { const r = rows.find((x) => x.id === Number(ed.dataset.edit)); openEditor({ title: 'Chỉnh sửa', fields, values: toValues(r), onSubmit: save(r.id) }); }
    const del = e.target.closest('[data-del]');
    if (del && confirm('Xóa mục này?')) {
      try { await api(`${endpoint}/${del.dataset.del}`, { method: 'DELETE' }); toast('Đã xóa.', 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
    }
  };
}

async function renderColors() {
  const { colors } = await api('/api/catalog');
  simpleTable({
    rows: colors, addLabel: 'Thêm màu sơn', endpoint: '/api/admin/colors', reload: renderColors,
    emptyTitle: 'Chưa có màu sơn', emptyText: 'Màu sơn dùng để lọc mẫu và hiển thị trong phần thử màu 3D.',
    columns: [
      ['Màu', (r) => `<span class="swatch finish-${r.finish}" style="--c:${esc(r.hex)};display:inline-block;cursor:default"></span>`],
      ['Tên', (r) => `<span class="strong">${esc(r.name)}</span>`],
      ['Mã', (r) => `<code>${esc(r.hex)}</code>`],
      ['Hiệu ứng', (r) => FINISH[r.finish]],
      ['Thứ tự', (r) => r.sort],
    ],
    fields: [
      { name: 'name', label: 'Tên màu', required: true, min: 2, max: 40 },
      { name: 'hex', label: 'Mã màu', type: 'color', required: true },
      { name: 'finish', label: 'Hiệu ứng', type: 'select', options: Object.entries(FINISH) },
      { name: 'sort', label: 'Thứ tự hiển thị', type: 'number', default: 0 },
    ],
  });
}

async function renderCategories() {
  const [{ categories }, { designs }] = await Promise.all([api('/api/catalog'), api('/api/admin/designs')]);
  simpleTable({
    rows: categories, addLabel: 'Thêm danh mục', endpoint: '/api/admin/categories', reload: renderCategories,
    emptyTitle: 'Chưa có danh mục', emptyText: 'Ví dụ: French, Sơn gel trơn, Vẽ họa tiết, Mắt mèo…',
    columns: [
      ['Tên danh mục', (r) => `<span class="strong">${esc(r.name)}</span>`],
      ['Số mẫu', (r) => designs.filter((d) => d.category_id === r.id).length],
      ['Thứ tự', (r) => r.sort],
    ],
    fields: [
      { name: 'name', label: 'Tên danh mục', required: true, min: 2, max: 40 },
      { name: 'sort', label: 'Thứ tự hiển thị', type: 'number', default: 0 },
    ],
  });
}

// Fields of a service (menu item); shared by the "Dịch vụ" page and the menu editor in "Thiết kế giao diện".
function serviceFields(services) {
  const groups = [...new Set(services.map((s) => s.group).filter(Boolean))];
  return [
    { name: 'group', label: 'Nhóm trong menu', max: 40, suggest: groups, hint: 'Ví dụ: Sơn gel, Nối móng, Chăm sóc. Các dịch vụ cùng nhóm được xếp chung dưới một tiêu đề.' },
    { name: 'name', label: 'Tên dịch vụ', required: true, min: 2, max: 80 },
    { name: 'price_from', label: 'Giá (VNĐ)', type: 'number', hint: 'Để 0 nếu muốn hiển thị "Liên hệ".' },
    { name: 'duration', label: 'Thời lượng (phút)', type: 'number', step: 5, default: 60 },
    { name: 'description', label: 'Mô tả ngắn', type: 'textarea', max: 300 },
    { name: 'active', label: 'Hiển thị trên trang khách', type: 'checkbox', default: true },
  ];
}

async function renderServices() {
  const { services } = await api('/api/admin/services');
  simpleTable({
    rows: services, addLabel: 'Thêm dịch vụ', endpoint: '/api/admin/services', reload: renderServices,
    emptyTitle: 'Chưa có dịch vụ', emptyText: 'Dịch vụ hiện trong menu trang chủ và để khách chọn khi đặt lịch.',
    toValues: (r) => ({ ...r, group: r.group || '', active: !!r.active }),
    columns: [
      ['Nhóm', (r) => esc(r.group || '—')],
      ['Tên dịch vụ', (r) => `<div class="strong">${esc(r.name)}</div><div class="small">${esc(r.description || '')}</div>`],
      ['Giá', (r) => vnd(r.price_from)],
      ['Thời lượng', (r) => (r.duration ? `${r.duration} phút` : '—')],
      ['Hiển thị', (r) => (r.active ? '<span class="pill on">Đang hiện</span>' : '<span class="pill">Đang ẩn</span>')],
    ],
    fields: [...serviceFields(services), { name: 'sort', label: 'Thứ tự hiển thị', type: 'number', step: 1, default: 0 }],
  });
}

// ---------------------------------------------------------------- customers
async function renderCustomers() {
  const { customers } = await api('/api/admin/customers');
  view.innerHTML = `
    <div class="help">${icon('info', 16)} Quyền <strong>Admin</strong> được vào trang quản trị (xem thống kê, đổi giao diện, xử lý lịch hẹn). Quyền <strong>Khách hàng</strong> chỉ đặt lịch và xem lịch của mình.</div>
    <div class="toolbar"><label class="search"><span class="sr-only">Tìm khách hàng</span>${icon('search', 16)}<input type="search" id="cq" placeholder="Tìm tên, email, SĐT…"></label></div>
    ${customers.length ? `<div class="table-wrap"><table><thead><tr><th>Họ tên</th><th>Liên hệ</th><th>Ngày đăng ký</th><th>Số lịch</th><th>Phân quyền</th></tr></thead>
      <tbody>${customers.map((c) => `<tr data-s="${esc(`${c.name} ${c.email} ${c.phone || ''}`.toLowerCase())}">
        <td class="strong">${esc(c.name)}${c.id === me.id ? ' <span class="pill">Bạn</span>' : ''}</td>
        <td><div>${esc(c.email)}</div><div class="small">${esc(c.phone || '')}</div></td>
        <td class="small">${fmtDateTime(c.created_at)}</td>
        <td>${c.bookings}</td>
        <td><label><span class="sr-only">Quyền của ${esc(c.name)}</span><select class="status-select" data-role="${c.id}" ${c.id === me.id ? 'disabled' : ''}>
          <option value="customer" ${c.role === 'customer' ? 'selected' : ''}>Khách hàng</option><option value="admin" ${c.role === 'admin' ? 'selected' : ''}>Admin</option></select></label></td>
      </tr>`).join('')}</tbody></table></div>` : emptyState('users', 'Chưa có khách hàng', 'Khách hàng đăng ký tài khoản sẽ xuất hiện ở đây.')}`;
  $('#cq').oninput = (e) => { const q = e.target.value.toLowerCase().trim(); for (const tr of $$('tr[data-s]', view)) tr.hidden = q && !tr.dataset.s.includes(q); };
  view.onchange = async (e) => {
    const sel = e.target.closest('[data-role]');
    if (!sel) return;
    const label = sel.value === 'admin' ? 'cấp quyền Admin' : 'chuyển về Khách hàng';
    if (!confirm(`Xác nhận ${label} cho tài khoản này?`)) { renderCustomers(); return; }
    try { await api(`/api/admin/customers/${sel.dataset.role}`, { method: 'PATCH', body: { role: sel.value } }); toast('Đã cập nhật phân quyền.', 'success'); }
    catch (err) { toast(err.message, 'error'); renderCustomers(); }
  };
}

// ---------------------------------------------------------------- appearance
const PRESETS = [
  { name: 'Hồng mận', primaryColor: '#9D2B5B', accentColor: '#B08D57', bgColor: '#FBF7F4', textColor: '#2E1A24' },
  { name: 'Nude be', primaryColor: '#8A5A44', accentColor: '#B89B72', bgColor: '#FAF6F1', textColor: '#2B211C' },
  { name: 'Xanh sage', primaryColor: '#4F6B58', accentColor: '#B08D57', bgColor: '#F6F7F2', textColor: '#1F2A22' },
  { name: 'Đen champagne', primaryColor: '#1F1A1C', accentColor: '#B08D57', bgColor: '#F8F5F0', textColor: '#1F1A1C' },
  { name: 'Lavender', primaryColor: '#6D4C9F', accentColor: '#C29A6B', bgColor: '#F9F7FC', textColor: '#271C33' },
];

// Inline list of menu items inside "Thiết kế giao diện". Changes go straight to the API.
async function renderServiceEditor(box, onChange) {
  let services;
  try {
    ({ services } = await api('/api/admin/services'));
  } catch (e) {
    box.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
    return;
  }
  const refresh = () => { renderServiceEditor(box, onChange); onChange?.(); };
  const body = (s, patch = {}) => ({ name: s.name, group: s.group || '', description: s.description || '', price_from: s.price_from, duration: s.duration, sort: s.sort, active: !!s.active, ...patch });
  box.innerHTML = `
    ${services.length ? `<ul class="svc-list">${services.map((s, i) => `
      <li class="svc-row${s.active ? '' : ' off'}">
        <div class="svc-order">
          <button type="button" class="icon-btn" data-move="-1" data-i="${i}" aria-label="Đưa ${esc(s.name)} lên" ${i === 0 ? 'disabled' : ''}>${icon('up', 16)}</button>
          <button type="button" class="icon-btn" data-move="1" data-i="${i}" aria-label="Đưa ${esc(s.name)} xuống" ${i === services.length - 1 ? 'disabled' : ''}>${icon('down', 16)}</button>
        </div>
        <div class="svc-info"><strong>${esc(s.name)}</strong><small>${esc(s.group || 'Không có nhóm')} · ${vnd(s.price_from)}${s.duration ? ` · ${s.duration} phút` : ''}${s.active ? '' : ' · đang ẩn'}</small></div>
        <div class="row-actions">
          <button type="button" class="icon-btn" data-edit="${i}" aria-label="Sửa ${esc(s.name)}">${icon('pencil', 18)}</button>
          <button type="button" class="icon-btn danger" data-del="${i}" aria-label="Xóa ${esc(s.name)}">${icon('trash', 18)}</button>
        </div>
      </li>`).join('')}</ul>` : '<p class="hint">Chưa có dịch vụ nào.</p>'}
    <button type="button" class="btn btn-ghost btn-sm" data-add>${icon('plus', 16)}Thêm dịch vụ</button>`;

  box.onclick = async (e) => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    try {
      if (t.matches('[data-add]')) {
        const nextSort = services.length ? Math.max(...services.map((s) => s.sort)) + 1 : 0;
        openEditor({
          title: 'Thêm dịch vụ', fields: serviceFields(services), values: { group: services.at(-1)?.group || '' },
          onSubmit: async (data) => { await api('/api/admin/services', { method: 'POST', body: { ...data, sort: nextSort } }); toast('Đã thêm dịch vụ.', 'success'); refresh(); },
        });
      } else if (t.dataset.edit) {
        const s = services[Number(t.dataset.edit)];
        openEditor({
          title: 'Sửa dịch vụ', fields: serviceFields(services), values: { ...s, group: s.group || '', active: !!s.active },
          onSubmit: async (data) => { await api(`/api/admin/services/${s.id}`, { method: 'PUT', body: body(s, data) }); toast('Đã lưu.', 'success'); refresh(); },
        });
      } else if (t.dataset.del) {
        const s = services[Number(t.dataset.del)];
        if (!confirm(`Xóa dịch vụ "${s.name}"? Lịch hẹn cũ vẫn được giữ lại.`)) return;
        await api(`/api/admin/services/${s.id}`, { method: 'DELETE' });
        toast('Đã xóa.', 'success');
        refresh();
      } else if (t.dataset.move) {
        // Renumber everything so the order is explicit, then swap the two neighbours.
        const order = services.slice();
        const i = Number(t.dataset.i);
        const j = i + Number(t.dataset.move);
        [order[i], order[j]] = [order[j], order[i]];
        t.disabled = true;
        await Promise.all(order.map((s, k) => (s.sort === k ? null : api(`/api/admin/services/${s.id}`, { method: 'PUT', body: body(s, { sort: k }) }))));
        refresh();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

async function renderAppearance() {
  settings = await api('/api/admin/settings');
  const s = settings;
  const text = (k, label, max = 120) => `<div class="field"><label for="ap-${k}">${label}</label><input id="ap-${k}" name="${k}" value="${esc(s[k])}" maxlength="${max}"></div>`;
  const area = (k, label) => `<div class="field"><label for="ap-${k}">${label}</label><textarea id="ap-${k}" name="${k}" rows="3" maxlength="600">${esc(s[k])}</textarea></div>`;
  const color = (k, label) => `<div class="field"><label for="ap-${k}">${label}</label><div class="color-field"><input type="color" value="${esc(s[k])}" data-for="${k}" aria-label="${label}"><input id="ap-${k}" name="${k}" value="${esc(s[k])}" maxlength="7" spellcheck="false"></div></div>`;
  const select = (k, label, opts) => `<div class="field"><label for="ap-${k}">${label}</label><select id="ap-${k}" name="${k}">${opts.map((o) => `<option ${o === s[k] ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
  const toggle = (k, label) => `<label class="check"><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''}>${label}</label>`;
  const logo = () => `<div class="field"><span class="label">Logo</span>
    <div class="upload logo" data-upload="logoImage" data-kind="logo">
      <div class="upload-preview">${s.logoImage ? `<img src="${esc(s.logoImage)}" alt="">` : icon('image', 28)}</div>
      <div><div class="upload-actions">
        <span class="btn btn-ghost btn-sm upload-btn">${icon('upload', 16)}<span data-after="Thay logo">${s.logoImage ? 'Thay logo' : 'Tải logo lên'}</span><input type="file" accept="image/png,image/webp,image/jpeg,image/avif" aria-label="Tải logo"></span>
        <button type="button" class="btn btn-ghost btn-sm" data-clear ${s.logoImage ? '' : 'hidden'}>${icon('trash', 16)}Gỡ logo</button>
      </div><p class="hint">Nên dùng PNG nền trong suốt, tối đa 8MB. Logo cũng được dùng làm biểu tượng trên tab trình duyệt.</p></div>
      <input type="hidden" name="logoImage" value="${esc(s.logoImage)}">
      <input type="hidden" name="logoIcon" value="${esc(s.logoIcon)}" data-from="icon">
    </div></div>
    <div class="field"><label for="ap-logoHeight">Chiều cao logo: <output id="logo-h-out">${esc(s.logoHeight)}</output>px</label><input id="ap-logoHeight" name="logoHeight" type="range" min="24" max="96" value="${esc(s.logoHeight)}"></div>
    ${toggle('showBrandText', 'Hiện tên tiệm & khẩu hiệu cạnh logo')}`;
  const image = (k, label) => `<div class="field"><span class="label">${label}</span><div class="upload" data-upload="${k}"><div class="upload-preview">${s[k] ? `<img src="${esc(s[k])}" alt="">` : icon('image', 28)}</div>
    <div><span class="btn btn-ghost btn-sm upload-btn">${icon('upload', 16)}Đổi ảnh<input type="file" accept="image/jpeg,image/png,image/webp,image/avif" aria-label="${label}"></span></div>
    <input type="hidden" name="${k}" value="${esc(s[k])}"></div></div>`;

  view.innerHTML = `
    <form class="appearance" id="ap-form" novalidate>
      <div class="panel">
        <details open><summary>${icon('palette', 18)}Màu sắc & phong cách</summary><div class="inner">
          <div class="presets">${PRESETS.map((p, i) => `<button type="button" class="preset" data-preset="${i}"><i><b style="background:${p.primaryColor}"></b><b style="background:${p.accentColor}"></b></i>${p.name}</button>`).join('')}</div>
          ${color('primaryColor', 'Màu chính (nút, điểm nhấn)')}${color('accentColor', 'Màu phụ (tiêu đề nhỏ, viền)')}
          ${color('bgColor', 'Màu nền')}${color('textColor', 'Màu chữ')}
          ${select('headingFont', 'Font tiêu đề', FONT_OPTIONS.heading)}${select('bodyFont', 'Font nội dung', FONT_OPTIONS.body)}
          <div class="field"><label for="ap-radius">Độ bo góc: <output id="radius-out">${esc(s.radius)}</output>px</label><input id="ap-radius" name="radius" type="range" min="0" max="28" value="${esc(s.radius)}"></div>
          <p class="hint" id="contrast-warn" role="status"></p>
        </div></details>
        <details open><summary>${icon('gem', 18)}Logo & thương hiệu</summary><div class="inner">
          ${logo()}
          ${text('brandName', 'Tên tiệm', 60)}${text('tagline', 'Khẩu hiệu')}
          <div class="field"><label for="ap-siteTitle">Tiêu đề trên tab trình duyệt</label><input id="ap-siteTitle" name="siteTitle" value="${esc(s.siteTitle)}" maxlength="120" placeholder="${esc(tabTitle({ ...s, siteTitle: '' }))}"><p class="hint">Để trống để tự dùng "Tên tiệm · Khẩu hiệu".</p></div>
        </div></details>
        <details><summary>${icon('sparkles', 18)}Nội dung trang chủ</summary><div class="inner">
          ${text('heroEyebrow', 'Dòng giới thiệu nhỏ (hero)')}${text('heroTitle', 'Tiêu đề lớn (hero)', 120)}${area('heroSubtitle', 'Mô tả (hero)')}
          ${image('heroImage', 'Ảnh hero')}
          ${text('aboutTitle', 'Tiêu đề phần giới thiệu')}${area('aboutText', 'Nội dung giới thiệu')}${area('aboutQuote', 'Câu trích dẫn')}
          ${image('aboutImage', 'Ảnh phần giới thiệu')}
        </div></details>
        <details id="menu-group"><summary>${icon('scissors', 18)}Menu dịch vụ</summary><div class="inner">
          <p class="help">Phần "Dịch vụ" trên trang chủ: một bên là ảnh bảng giá đầy đủ (khách nhấn để phóng to), bên kia là danh sách dịch vụ để khách bấm đặt lịch.</p>
          ${text('servicesEyebrow', 'Dòng chữ nhỏ phía trên', 40)}${text('servicesTitle', 'Tiêu đề', 80)}${area('servicesSubtitle', 'Mô tả dưới tiêu đề')}
          <div class="field"><span class="label">Ảnh menu (bảng giá đầy đủ)</span>
            <div class="upload menu-upload" data-upload="servicesMenuImage" data-kind="menu">
              <div class="upload-preview">${s.servicesMenuThumb || s.servicesMenuImage ? `<img src="${esc(s.servicesMenuThumb || s.servicesMenuImage)}" alt="">` : icon('image', 28)}</div>
              <div><div class="upload-actions">
                <span class="btn btn-ghost btn-sm upload-btn">${icon('upload', 16)}<span data-after="Thay ảnh menu">${s.servicesMenuImage ? 'Thay ảnh menu' : 'Tải ảnh menu'}</span><input type="file" accept="image/jpeg,image/png,image/webp,image/avif" aria-label="Tải ảnh menu dịch vụ"></span>
                <button type="button" class="btn btn-ghost btn-sm" data-clear ${s.servicesMenuImage ? '' : 'hidden'}>${icon('trash', 16)}Gỡ ảnh</button>
              </div><p class="hint">Ảnh dọc, chữ rõ nét, tối đa 8MB. Không có ảnh thì danh sách dịch vụ chiếm cả chiều ngang.</p></div>
              <input type="hidden" name="servicesMenuImage" value="${esc(s.servicesMenuImage)}">
              <input type="hidden" name="servicesMenuThumb" value="${esc(s.servicesMenuThumb)}" data-from="thumb">
            </div></div>
          <div class="field"><span class="label" id="side-label">Vị trí ảnh menu</span>
            <input type="hidden" name="servicesImageSide" value="${esc(s.servicesImageSide)}">
            <div class="range" role="group" aria-labelledby="side-label">
              <button type="button" data-side="left" aria-pressed="${s.servicesImageSide !== 'right'}">Ảnh bên trái</button>
              <button type="button" data-side="right" aria-pressed="${s.servicesImageSide === 'right'}">Ảnh bên phải</button>
            </div></div>
          ${text('servicesNote', 'Ghi chú dưới menu (tùy chọn)', 200)}
          <div class="field"><span class="label">Các dịch vụ trong menu</span>
            <p class="hint">Thêm, sửa, sắp xếp được lưu ngay, không cần bấm "Lưu & áp dụng".</p>
            <div class="svc-editor" id="svc-editor"><div class="skeleton" style="height:120px"></div></div>
          </div>
        </div></details>
        <details><summary>${icon('grid', 18)}Các phần hiển thị</summary><div class="inner" style="display:grid">
          ${toggle('showAbout', 'Giới thiệu / triết lý')}${toggle('showServices', 'Dịch vụ')}${toggle('showWhy', 'Vì sao chọn chúng tôi')}
          ${toggle('show3D', 'Thử màu 3D')}${toggle('showProcess', 'Quy trình đặt lịch')}
        </div></details>
        <details><summary>${icon('pin', 18)}Liên hệ & giờ mở cửa</summary><div class="inner">
          ${text('phone', 'Số điện thoại hiển thị', 20)}${text('address', 'Địa chỉ', 200)}${text('hours', 'Giờ mở cửa (hiển thị)')}
          <div class="field-row">${text('openTime', 'Giờ nhận khách đầu tiên (HH:mm)', 5)}${text('closeTime', 'Giờ nhận khách cuối (HH:mm)', 5)}</div>
          ${text('slotCapacity', 'Số khách tối đa mỗi khung 30 phút', 2)}
          ${text('zaloPhone', 'Số Zalo của tiệm (nút chat Zalo)', 15)}${text('messengerUsername', 'Username Facebook Page (nút Messenger, m.me/…)', 80)}
          ${text('facebookUrl', 'Link Facebook', 300)}${text('instagramUrl', 'Link Instagram', 300)}${text('tiktokUrl', 'Link TikTok', 300)}${text('mapUrl', 'Link Google Maps', 300)}
        </div></details>
        <div class="form-error" role="alert" hidden></div>
        <div class="save-bar"><button type="button" class="btn btn-ghost" id="ap-reset">Hoàn tác</button><button class="btn btn-primary" type="submit">Lưu & áp dụng</button></div>
      </div>
      <div class="preview">
        <div class="preview-bar"><span class="dots"><i></i><i></i><i></i></span>Xem trước trực tiếp (chưa lưu)
          <div class="range" role="group" aria-label="Kích thước xem trước"><button type="button" data-pv="desktop" aria-pressed="true">Máy tính</button><button type="button" data-pv="mobile" aria-pressed="false">Điện thoại</button></div></div>
        <iframe class="preview-frame" id="pv" src="/" title="Xem trước trang khách hàng"></iframe>
      </div>
    </form>`;

  const form = $('#ap-form');
  const pv = $('#pv');
  const collect = () => {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
    }
    return out;
  };
  const push = () => {
    pv.contentWindow?.postMessage({ type: 'preview-settings', settings: collect() }, location.origin);
    checkContrast();
  };
  pv.addEventListener('load', push);
  form.addEventListener('input', (e) => {
    const t = e.target;
    if (t.type === 'color' && t.dataset.for) form.elements[t.dataset.for].value = t.value.toUpperCase();
    if (t.name && /Color$/.test(t.name) && /^#[0-9a-f]{6}$/i.test(t.value)) $(`[data-for="${t.name}"]`).value = t.value;
    if (t.name === 'radius') $('#radius-out').textContent = t.value;
    if (t.name === 'logoHeight') $('#logo-h-out').textContent = t.value;
    push();
  });
  form.addEventListener('change', push);
  for (const up of $$('[data-upload]', form)) wireUpload(up, push);
  for (const btn of $$('[data-clear]', form)) {
    btn.onclick = () => {
      const box = btn.closest('[data-upload]');
      for (const h of $$('input[type=hidden]', box)) h.value = '';
      $('.upload-preview', box).innerHTML = icon('image', 28);
      btn.hidden = true;
      push();
    };
  }
  for (const b of $$('[data-side]', form)) {
    b.onclick = () => {
      form.elements.servicesImageSide.value = b.dataset.side;
      for (const x of $$('[data-side]', form)) x.setAttribute('aria-pressed', String(x === b));
      push();
    };
  }
  // Opening the menu group scrolls the preview to the services section.
  $('#menu-group').addEventListener('toggle', (e) => {
    if (e.target.open) pv.contentDocument?.getElementById('services')?.scrollIntoView({ behavior: 'smooth' });
  });
  const reloadPreview = () => pv.contentWindow?.location.reload();
  renderServiceEditor($('#svc-editor'), reloadPreview);
  $$('[data-preset]').forEach((b) => (b.onclick = () => {
    const p = PRESETS[b.dataset.preset];
    for (const k of ['primaryColor', 'accentColor', 'bgColor', 'textColor']) { form.elements[k].value = p[k]; $(`[data-for="${k}"]`).value = p[k]; }
    push();
  }));
  $$('[data-pv]').forEach((b) => (b.onclick = () => {
    $$('[data-pv]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    pv.classList.toggle('mobile', b.dataset.pv === 'mobile');
  }));
  $('#ap-reset').onclick = () => renderAppearance();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.hidden = true;
    const btn = $('button[type=submit]', form);
    btn.classList.add('loading');
    try {
      settings = await api('/api/admin/settings', { method: 'PUT', body: collect() });
      renderSideBrand();
      applyTheme({ ...settings, bgColor: '#F7F4F2' });
      toast('Đã lưu giao diện. Trang khách hàng đã được cập nhật.', 'success');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    finally { btn.classList.remove('loading'); }
  };

  function checkContrast() {
    const v = collect();
    const ratio = contrast(v.primaryColor, '#FFFFFF');
    const ratio2 = contrast(v.textColor, v.bgColor);
    const msgs = [];
    if (ratio && ratio < 4.5) msgs.push(`Chữ trắng trên màu chính chỉ đạt ${ratio.toFixed(1)}:1 (nên ≥ 4.5:1) — hãy chọn màu chính đậm hơn.`);
    if (ratio2 && ratio2 < 4.5) msgs.push(`Màu chữ trên nền chỉ đạt ${ratio2.toFixed(1)}:1 (nên ≥ 4.5:1).`);
    const w = $('#contrast-warn');
    w.textContent = msgs.join(' ');
    w.style.color = msgs.length ? 'var(--danger)' : '';
  }
}

function contrast(a, b) {
  const lum = (hex) => {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return null;
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const la = lum(a), lb = lum(b);
  if (la == null || lb == null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------------------------------------------------------------- notifications
async function renderNotify() {
  settings = await api('/api/admin/settings');
  const s = settings;
  const inp = (k, label, ph = '', type = 'text') => `<div class="field"><label for="nt-${k}">${label}</label><input id="nt-${k}" name="${k}" type="${type}" value="${esc(s[k])}" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false"></div>`;
  const on = (...keys) => keys.every((k) => s[k]);
  const channel = (key, title, enabled, help, fields) => `
    <section class="card channel">
      <div class="card-head"><h2>${title}</h2><span class="pill ${enabled ? 'on' : ''}">${enabled ? 'Đã cấu hình' : 'Chưa cấu hình'}</span></div>
      <div class="help">${help}</div>
      ${fields}
      <button type="button" class="btn btn-ghost btn-sm" data-test="${key}">${icon('send', 16)}Gửi tin thử</button><span class="test-result" data-result="${key}" role="status"></span>
    </section>`;
  view.innerHTML = `
    <div class="help">${icon('info', 16)} Mỗi khi khách đặt lịch hoặc yêu cầu tư vấn, hệ thống sẽ gửi tin nhắn đến <strong>tất cả kênh đã cấu hình</strong>. Ngoài ra trang quản trị tự kiểm tra lịch mới mỗi phút (khi tab đang mở) và hiện thông báo (bấm biểu tượng chuông ở góc trên để bật thông báo trình duyệt).</div>
    <form id="nt-form" novalidate>
      ${channel('zalo', 'Zalo Official Account', on('notifyZaloOaToken', 'notifyZaloUserId'),
        `<ol><li>Tạo Zalo OA tại <strong>oa.zalo.me</strong> và ứng dụng tại <strong>developers.zalo.me</strong>, liên kết OA với ứng dụng.</li>
         <li>Lấy <code>access_token</code> của OA (API Explorer hoặc OAuth v4). Token có hạn dùng, cần làm mới định kỳ.</li>
         <li>Dùng Zalo cá nhân của chủ tiệm <strong>quan tâm OA</strong> và nhắn 1 tin, sau đó lấy <code>user_id</code> trong mục Tin nhắn/Webhook của OA.</li></ol>`,
        inp('notifyZaloOaToken', 'OA Access Token', '', 'password') + inp('notifyZaloUserId', 'User ID của admin (người nhận)'))}
      ${channel('messenger', 'Facebook Messenger', on('notifyMessengerPageToken', 'notifyMessengerPsid'),
        `<ol><li>Tạo ứng dụng tại <strong>developers.facebook.com</strong>, thêm sản phẩm Messenger và kết nối Facebook Page của tiệm.</li>
         <li>Tạo <code>Page Access Token</code>.</li>
         <li>Dùng Facebook cá nhân nhắn tin cho Page, lấy <code>PSID</code> từ webhook. Lưu ý: Messenger chỉ cho gửi trong 24 giờ kể từ tin nhắn gần nhất của bạn tới Page.</li></ol>`,
        inp('notifyMessengerPageToken', 'Page Access Token', '', 'password') + inp('notifyMessengerPsid', 'PSID của admin (người nhận)'))}
      ${channel('telegram', 'Telegram (khuyên dùng — ổn định, miễn phí)', on('notifyTelegramToken', 'notifyTelegramChatId'),
        `<ol><li>Nhắn <code>@BotFather</code> → <code>/newbot</code> để lấy Bot Token.</li><li>Nhắn cho bot vừa tạo 1 tin bất kỳ, rồi mở <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> để lấy <code>chat.id</code>.</li></ol>`,
        inp('notifyTelegramToken', 'Bot Token', '123456:ABC…', 'password') + inp('notifyTelegramChatId', 'Chat ID'))}
      ${channel('webhook', 'Webhook (Zapier / Make / n8n / Google Sheets…)', on('notifyWebhookUrl'),
        'Hệ thống gửi <code>POST</code> JSON <code>{ text, booking }</code> tới URL https bạn cung cấp.',
        inp('notifyWebhookUrl', 'Webhook URL', 'https://…'))}
      <div class="form-error" role="alert" hidden></div>
      <div class="save-bar"><button class="btn btn-primary" type="submit">Lưu cấu hình</button></div>
    </form>`;
  const form = $('#nt-form');
  const collect = () => Object.fromEntries([...form.elements].filter((e) => e.name).map((e) => [e.name, e.value.trim()]));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.hidden = true;
    try { settings = await api('/api/admin/settings', { method: 'PUT', body: collect() }); toast('Đã lưu cấu hình thông báo.', 'success'); renderNotify(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  form.onclick = async (e) => {
    const b = e.target.closest('[data-test]');
    if (!b) return;
    const key = b.dataset.test;
    const out = $(`[data-result="${key}"]`);
    b.classList.add('loading');
    try {
      await api('/api/admin/settings', { method: 'PUT', body: collect() });
      const { result } = await api('/api/admin/notify-test', { method: 'POST', body: { channel: key } });
      const r = result[key];
      out.textContent = r === 'ok' ? 'Đã gửi thành công.' : r === 'skipped' ? 'Chưa điền đủ thông tin.' : r;
      out.style.color = r === 'ok' ? 'var(--success)' : 'var(--danger)';
    } catch (ex) { out.textContent = ex.message; out.style.color = 'var(--danger)'; }
    finally { b.classList.remove('loading'); }
  };
}

// ---------------------------------------------------------------- account
async function renderAccount() {
  view.innerHTML = `
    <section class="card" style="max-width:520px">
      <form id="acc-form" novalidate>
        <div class="field"><label for="a-name">Họ tên</label><input id="a-name" name="name" value="${esc(me.name)}"></div>
        <div class="field"><label for="a-phone">Số điện thoại</label><input id="a-phone" name="phone" type="tel" value="${esc(me.phone || '')}"></div>
        <div class="field"><label for="a-email">Email đăng nhập</label><input id="a-email" value="${esc(me.email)}" disabled></div>
        <div class="field"><label for="a-cur">Mật khẩu hiện tại</label><input id="a-cur" name="currentPassword" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="a-new">Mật khẩu mới</label><input id="a-new" name="newPassword" type="password" autocomplete="new-password"><p class="hint">Để trống nếu không đổi. Tối thiểu 8 ký tự gồm chữ và số.</p></div>
        <div class="form-error" role="alert" hidden></div>
        <button class="btn btn-primary" type="submit">Lưu thay đổi</button>
      </form>
    </section>`;
  const form = $('#acc-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.hidden = true;
    for (const i of $$('input', form)) setFieldError(i, '');
    try {
      ({ user: me } = await api('/api/auth/profile', { method: 'PUT', body: Object.fromEntries(new FormData(form)) }));
      $('#who').textContent = me.name;
      form.currentPassword.value = form.newPassword.value = '';
      toast('Đã lưu.', 'success');
    } catch (ex) {
      for (const [k, m] of Object.entries(ex.fields || {})) if (form.elements[k]) setFieldError(form.elements[k], m);
      err.textContent = ex.message;
      err.hidden = false;
    }
  };
}
