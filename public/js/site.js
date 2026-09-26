import {
  api, esc, vnd, $, $$, icon, hydrateIcons, toast, fmtDate, todayISO,
  validateForm, liveValidate, applyServerErrors, setFieldError, applyTheme, STATUS,
} from './common.js';

const state = {
  settings: {},
  catalog: { categories: [], colors: [], services: [], designs: [] },
  user: null,
  filter: { cat: 'all', color: null },
  list: [],
  lbIndex: 0,
  // current booking context
  bk: { kind: 'booking', design: null, color: null, customColor: null, editContact: false },
  try: { color: null, customColor: null, finish: 'gloss', shape: 'almond', french: false },
};

// ================= bootstrap =================
hydrateIcons();
$('#year').textContent = new Date().getFullYear();
init();

async function init() {
  $('#design-grid').innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton card"></div>').join('');
  try {
    const [settings, catalog, me] = await Promise.all([api('/api/settings'), api('/api/catalog'), api('/api/auth/me')]);
    state.settings = settings;
    state.catalog = catalog;
    state.user = me.user;
  } catch (e) {
    toast(e.message, 'error');
  }
  renderAll();
  track();
  wireUI();
  const params = new URLSearchParams(location.search);
  if (params.has('login')) openAuth('login', params.get('login') === 'admin' ? 'Đăng nhập bằng tài khoản quản trị để vào trang admin.' : '');
}

function renderAll() {
  applyTheme(state.settings);
  fillSettings();
  renderAccount();
  renderServices();
  renderFilters();
  renderDesigns();
  renderHeroFloat();
  renderContact();
  setupTry3D();
}

// ================= settings → page =================
function fillSettings() {
  const s = state.settings;
  document.title = `${s.brandName} — Xem mẫu & đặt lịch làm nail`;
  for (const el of $$('[data-setting]')) el.textContent = s[el.dataset.setting] || '';
  for (const el of $$('[data-show]')) el.hidden = !s[el.dataset.show];
  const tel = (s.phone || '').replace(/[^\d+]/g, '');
  for (const el of $$('[data-href="tel"]')) el.href = `tel:${tel}`;
  for (const el of $$('[data-section]')) el.hidden = s[el.dataset.section] === false;
  const hero = $('#hero-img');
  if (s.heroImage) hero.src = s.heroImage;
  const about = $('#about-img');
  if (s.aboutImage) about.src = s.aboutImage; else about.parentElement.hidden = true;
  $('.topbar').hidden = !s.address && !s.hours && !s.phone;
}

function renderContact() {
  const s = state.settings;
  const tel = (s.phone || '').replace(/[^\d+]/g, '');
  const zalo = (s.zaloPhone || '').replace(/\D/g, '');
  const actions = [];
  if (tel) actions.push(`<a class="btn btn-ghost" href="tel:${esc(tel)}">${icon('phone', 18)}Gọi ngay</a>`);
  if (zalo) actions.push(`<a class="btn btn-zalo" href="https://zalo.me/${esc(zalo)}" target="_blank" rel="noopener">${icon('chat', 18)}Chat Zalo</a>`);
  if (s.messengerUsername) actions.push(`<a class="btn btn-mess" href="https://m.me/${encodeURIComponent(s.messengerUsername)}" target="_blank" rel="noopener">${icon('send', 18)}Messenger</a>`);
  if (s.mapUrl) actions.push(`<a class="btn btn-ghost" href="${esc(safeUrl(s.mapUrl))}" target="_blank" rel="noopener">${icon('pin', 18)}Chỉ đường</a>`);
  $('#contact-actions').innerHTML = actions.join('');

  const socials = [['facebookUrl', 'facebook', 'Facebook'], ['instagramUrl', 'instagram', 'Instagram'], ['tiktokUrl', 'music', 'TikTok']]
    .filter(([k]) => s[k])
    .map(([k, ic, label]) => `<a href="${esc(safeUrl(s[k]))}" target="_blank" rel="noopener" aria-label="${label}">${icon(ic, 20)}</a>`);
  $('#socials').innerHTML = socials.join('');
}
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '#');

// ================= account =================
function renderAccount() {
  const slot = $('#account-slot');
  const u = state.user;
  if (!u) {
    slot.innerHTML = `<button class="btn btn-ghost btn-sm" id="login-btn">${icon('user', 18)}<span class="hide-sm">Đăng nhập</span></button>`;
    $('#login-btn').setAttribute('aria-label', 'Đăng nhập hoặc đăng ký');
    $('#login-btn').onclick = () => openAuth('login');
    return;
  }
  const initial = esc((u.name || '?').trim().split(/\s+/).pop()[0]?.toUpperCase() || '?');
  slot.innerHTML = `
    <button class="account-btn" id="acc-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="acc-menu">
      <span class="avatar">${initial}</span><span class="nm hide-sm">${esc(u.name)}</span>${icon('down', 16)}
    </button>
    <div class="account-menu" id="acc-menu" role="menu" hidden>
      <div class="who"><strong>${esc(u.name)}</strong>${esc(u.email)}</div>
      ${u.role === 'admin' ? `<a href="/admin" role="menuitem">${icon('dashboard', 18)}Trang quản trị</a>` : ''}
      <button role="menuitem" data-me-open="bookings">${icon('calendar', 18)}Lịch hẹn của tôi</button>
      <button role="menuitem" data-me-open="profile">${icon('user', 18)}Thông tin tài khoản</button>
      <button role="menuitem" id="logout-btn">${icon('logout', 18)}Đăng xuất</button>
    </div>`;
  const btn = $('#acc-btn');
  const menu = $('#acc-menu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) menu.querySelector('[role=menuitem]')?.focus();
  };
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
  for (const b of $$('[data-me-open]', menu)) b.onclick = () => { close(); openMe(b.dataset.meOpen); };
  $('#logout-btn').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    renderAccount();
    toast('Bạn đã đăng xuất.');
  };
}

// ================= services =================
function renderServices() {
  const grid = $('#service-grid');
  const list = state.catalog.services;
  if (!list.length) {
    grid.innerHTML = emptyBox('scissors', 'Dịch vụ đang được cập nhật', 'Liên hệ với chúng tôi để được tư vấn dịch vụ phù hợp.');
    return;
  }
  grid.innerHTML = list.map((s) => `
    <article class="service-card">
      <div class="media ${s.image ? '' : 'noimg'}">${s.image ? `<img src="${esc(s.image)}" alt="" loading="lazy" width="400" height="300">` : icon('sparkles', 40)}</div>
      <div class="body">
        <h3>${esc(s.name)}</h3>
        ${s.description ? `<p>${esc(s.description)}</p>` : ''}
        <div class="service-meta">
          <span>${s.price_from > 0 ? `Từ <strong>${vnd(s.price_from)}</strong>` : '<strong>Liên hệ</strong>'}</span>
          <span>${s.duration ? `${icon('clock', 14)} ${s.duration} phút` : ''}</span>
        </div>
        <button class="link-btn" data-book-service="${s.id}">Đặt dịch vụ này ${icon('right', 16)}</button>
      </div>
    </article>`).join('');
}

function emptyBox(ic, title, text, action = '') {
  return `<div class="empty">${icon(ic, 40)}<h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
}

// ================= gallery =================
function renderFilters() {
  const { categories, colors, designs } = state.catalog;
  const used = new Set(designs.map((d) => d.category_id));
  const cats = categories.filter((c) => used.has(c.id));
  const catRow = $('#cat-filter');
  catRow.innerHTML = cats.length
    ? [`<button class="chip" data-cat="all" aria-pressed="${state.filter.cat === 'all'}">Tất cả</button>`,
      ...cats.map((c) => `<button class="chip" data-cat="${c.id}" aria-pressed="${state.filter.cat === c.id}">${esc(c.name)}</button>`)].join('')
    : '';
  const usedColors = new Set(designs.map((d) => d.color_id));
  const cols = colors.filter((c) => usedColors.has(c.id));
  $('#color-filter').innerHTML = cols.length
    ? `<span class="lbl">Màu:</span>${cols.map((c) => `<button class="swatch finish-${c.finish}" style="--c:${esc(c.hex)}" data-color="${c.id}" aria-pressed="${state.filter.color === c.id}" aria-label="${esc(c.name)}" title="${esc(c.name)}"></button>`).join('')}
       <button class="swatch-clear" data-color="" ${state.filter.color ? '' : 'hidden'}>Bỏ lọc màu</button>`
    : '';
  $('#filters').hidden = !cats.length && !cols.length;
}

function renderDesigns() {
  const { designs, categories, colors } = state.catalog;
  const catName = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const colorOf = Object.fromEntries(colors.map((c) => [c.id, c]));
  state.list = designs.filter((d) =>
    (state.filter.cat === 'all' || d.category_id === state.filter.cat) &&
    (!state.filter.color || d.color_id === state.filter.color));
  const grid = $('#design-grid');
  const count = $('#result-count');
  if (!designs.length) {
    count.textContent = '';
    grid.innerHTML = emptyBox('image', 'Bộ sưu tập đang được cập nhật', 'Các mẫu nail mới sẽ sớm xuất hiện. Bạn vẫn có thể đặt lịch hoặc nhờ tư vấn ngay.',
      '<button class="btn btn-primary" data-consult>Nhờ tư vấn mẫu</button>');
    return;
  }
  count.textContent = `${state.list.length} mẫu`;
  if (!state.list.length) {
    grid.innerHTML = emptyBox('search', 'Chưa có mẫu phù hợp', 'Thử bỏ bớt bộ lọc để xem thêm mẫu khác.', '<button class="btn btn-ghost" data-reset-filter>Xem tất cả mẫu</button>');
    return;
  }
  grid.innerHTML = state.list.map((d, i) => {
    const c = colorOf[d.color_id];
    return `
    <button class="design-card" data-index="${i}" style="animation-delay:${Math.min(i, 12) * 40}ms" aria-label="Xem mẫu ${esc(d.title)}">
      <div class="media"><img src="${esc(d.thumb || d.image)}" alt="" loading="lazy" width="300" height="400"></div>
      ${d.featured ? `<span class="badge">${icon('star', 12)}Nổi bật</span>` : ''}
      <span class="view">${icon('zoom', 18)}</span>
      <div class="info">
        <h3>${esc(d.title)}</h3>
        <div class="meta"><span>${c ? `<span class="dot" style="--c:${esc(c.hex)}"></span> ` : ''}${esc(catName[d.category_id] || '')}</span><span class="price">${vnd(d.price)}</span></div>
      </div>
    </button>`;
  }).join('');
}

function renderHeroFloat() {
  const d = state.catalog.designs.find((x) => x.featured) || state.catalog.designs[0];
  const el = $('#hero-float');
  if (!d) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<img src="${esc(d.thumb || d.image)}" alt=""><span><small>Mẫu nổi bật</small><strong>${esc(d.title)}</strong></span>`;
  el.setAttribute('aria-label', `Xem mẫu nổi bật ${d.title}`);
  el.onclick = () => {
    state.filter = { cat: 'all', color: null };
    renderFilters(); renderDesigns();
    openLightbox(state.list.findIndex((x) => x.id === d.id));
  };
}

// ================= lightbox =================
const lb = $('#lightbox');
function openLightbox(i) {
  if (i < 0 || !state.list.length) return;
  state.lbIndex = i;
  showLightboxItem();
  openDialog(lb);
}
function showLightboxItem() {
  const d = state.list[state.lbIndex];
  const cat = state.catalog.categories.find((c) => c.id === d.category_id);
  const color = state.catalog.colors.find((c) => c.id === d.color_id);
  const media = $('.lb-media', lb);
  media.classList.remove('zoomed');
  const img = $('#lb-img');
  img.src = d.image;
  img.alt = `Mẫu nail ${d.title}`;
  $('#lb-cat').textContent = cat?.name || 'Mẫu nail';
  $('#lb-title').textContent = d.title;
  $('#lb-price').textContent = d.price > 0 ? `Giá tham khảo: ${vnd(d.price)}` : 'Giá: liên hệ tư vấn';
  $('#lb-desc').textContent = d.description || '';
  $('#lb-color').innerHTML = color ? `<span class="dot" style="--c:${esc(color.hex)}"></span>Màu chủ đạo: <strong>${esc(color.name)}</strong>` : '';
  $('#lb-counter').textContent = `Mẫu ${state.lbIndex + 1} / ${state.list.length}`;
  const multi = state.list.length > 1;
  $('#lb-prev').hidden = $('#lb-next').hidden = !multi;
  $('#lb-note').textContent = state.user ? `Đặt nhanh bằng tài khoản ${state.user.name}` : 'Không cần đăng nhập để đặt lịch';
  track(`/mau/${d.id}`, d.id);
  // preload neighbours
  for (const k of [1, -1]) {
    const n = state.list[(state.lbIndex + k + state.list.length) % state.list.length];
    if (n) new Image().src = n.image;
  }
}
function stepLightbox(dir) {
  state.lbIndex = (state.lbIndex + dir + state.list.length) % state.list.length;
  showLightboxItem();
}

// ================= dialogs =================
function openDialog(d) {
  if (!d.open) d.showModal();
  document.body.classList.add('modal-open');
}
function closeDialog(d) { d.close(); }
for (const d of $$('dialog')) {
  d.addEventListener('close', () => { if (!$$('dialog').some((x) => x.open)) document.body.classList.remove('modal-open'); });
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // backdrop
  for (const b of $$('[data-close]', d)) b.addEventListener('click', () => d.close());
}

// ================= booking =================
const bkDialog = $('#booking');
const bkForm = $('#booking-form');
liveValidate(bkForm);

function openBooking({ kind = 'booking', design = null, color = null, customColor = null, serviceId = null } = {}) {
  state.bk = { kind, design, color, customColor, editContact: false };
  bkForm.reset();
  for (const el of $$('[aria-invalid]', bkForm)) setFieldError(el, '');
  $('#bk-error').hidden = true;
  $('#bk-body').hidden = false;
  $('#bk-success').hidden = true;

  // services
  const sel = $('#bk-service');
  const services = state.catalog.services;
  sel.innerHTML = '<option value="">— Chọn dịch vụ —</option>' +
    services.map((s) => `<option value="${s.id}">${esc(s.name)}${s.price_from ? ` · từ ${vnd(s.price_from)}` : ''}</option>`).join('');
  sel.closest('.field').hidden = !services.length;
  sel.dataset.rule = services.length ? 'required' : '';
  if (serviceId) sel.value = serviceId;
  else if (state.user && services.length) sel.value = services[0].id; // one-click for members

  // date
  const date = $('#bk-date');
  date.min = todayISO();
  date.max = todayISO(60);
  date.value = todayISO();

  setKind(kind);
  renderPicked();
  renderContactMode();
  openDialog(bkDialog);
  loadSlots(true);
}

function setKind(kind) {
  state.bk.kind = kind;
  for (const t of $$('[data-kind]', bkDialog)) t.setAttribute('aria-selected', String(t.dataset.kind === kind));
  $('#bk-schedule').hidden = kind !== 'booking';
  $('#bk-title').textContent = kind === 'booking' ? 'Đặt lịch làm nail' : 'Yêu cầu tư vấn';
  $('#bk-submit').textContent = kind === 'booking' ? 'Xác nhận đặt lịch' : 'Gửi yêu cầu tư vấn';
  $('#bk-foot').innerHTML = state.user ? ''
    : 'Đã có tài khoản? <button type="button" id="bk-login">Đăng nhập</button> để không phải nhập lại thông tin.';
  $('#bk-login')?.addEventListener('click', () => { closeDialog(bkDialog); openAuth('login', '', () => openBooking({ ...state.bk })); });
}

function renderPicked() {
  const { design, color, customColor } = state.bk;
  const parts = [];
  if (design) parts.push(`<div class="picked-item"><img src="${esc(design.thumb || design.image)}" alt=""><div class="t"><small>Mẫu đã chọn</small><strong>${esc(design.title)}</strong></div>
    <button type="button" class="icon-btn" data-unpick="design" aria-label="Bỏ chọn mẫu">${icon('x', 18)}</button></div>`);
  if (color || customColor) {
    const hex = color?.hex || customColor;
    parts.push(`<div class="picked-item"><span class="sw" style="--c:${esc(hex)}"></span><div class="t"><small>Màu sơn</small><strong>${esc(color?.name || 'Màu tự chọn ' + customColor)}</strong></div>
      <button type="button" class="icon-btn" data-unpick="color" aria-label="Bỏ chọn màu">${icon('x', 18)}</button></div>`);
  }
  $('#bk-picked').innerHTML = parts.join('');
}

function renderContactMode() {
  const u = state.user;
  const useAccount = u && u.phone && !state.bk.editContact;
  $('#bk-contact').hidden = !!useAccount;
  const acc = $('#bk-account');
  acc.hidden = !useAccount;
  if (useAccount) {
    acc.innerHTML = `${icon('check', 20)}<div><strong>${esc(u.name)}</strong>${esc(u.phone)} · ${esc(u.email)}</div><button type="button" id="bk-edit">Sửa</button>`;
    $('#bk-edit').onclick = () => {
      state.bk.editContact = true;
      renderContactMode();
      $('#bk-name').focus();
    };
  }
  if (u && !useAccount) {
    $('#bk-name').value ||= u.name || '';
    $('#bk-phone').value ||= u.phone || '';
    $('#bk-email').value ||= u.email || '';
  }
}

function timeSlots() {
  const { openTime = '09:00', closeTime = '19:30' } = state.settings;
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const out = [];
  for (let m = toMin(openTime); m <= toMin(closeTime); m += 30) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
}

let slotReq = 0;
async function loadSlots(autoPick = false) {
  const date = $('#bk-date').value;
  const box = $('#bk-slots');
  const hidden = $('#bk-time');
  hidden.value = '';
  if (!date) { box.innerHTML = '<p class="slots-empty">Chọn ngày để xem giờ trống.</p>'; return; }
  const req = ++slotReq;
  box.setAttribute('aria-busy', 'true');
  let full = [];
  try { full = (await api(`/api/slots?date=${date}`)).full; } catch { /* show all slots */ }
  if (req !== slotReq) return;
  box.removeAttribute('aria-busy');
  const now = new Date();
  const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const isToday = date === todayISO();
  const slots = timeSlots().map((t) => ({ t, off: full.includes(t) || (isToday && t <= nowHM) }));
  const free = slots.filter((s) => !s.off);
  if (!free.length) {
    // Today is over / fully booked — jump to the next day for convenience.
    if (autoPick && isToday) { $('#bk-date').value = todayISO(1); return loadSlots(true); }
    box.innerHTML = '<p class="slots-empty">Ngày này đã kín lịch, vui lòng chọn ngày khác.</p>';
    return;
  }
  box.innerHTML = slots.map(({ t, off }) =>
    `<button type="button" class="slot" role="radio" aria-checked="false" data-t="${t}" ${off ? 'disabled aria-disabled="true"' : ''} tabindex="-1">${t}</button>`).join('');
  const first = $('.slot:not(:disabled)', box);
  first.tabIndex = 0;
  if (autoPick && state.user) pickSlot(first);
}
function pickSlot(btn) {
  for (const b of $$('.slot', $('#bk-slots'))) { b.setAttribute('aria-checked', 'false'); b.tabIndex = -1; }
  btn.setAttribute('aria-checked', 'true');
  btn.tabIndex = 0;
  $('#bk-time').value = btn.dataset.t;
  setFieldError($('#bk-time'), '');
}

bkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = state.bk.kind;
  const contactFromAccount = state.user?.phone && !state.bk.editContact;
  if (!validateForm(bkForm)) {
    if ($('#bk-time').getAttribute('aria-invalid') === 'true') $('.slot:not(:disabled)', $('#bk-slots'))?.focus();
    return;
  }
  const f = new FormData(bkForm);
  const body = {
    type: kind,
    note: f.get('note'),
    design_id: state.bk.design?.id || null,
    color_id: state.bk.color?.id || null,
    custom_color: state.bk.color ? null : state.bk.customColor,
  };
  if (!contactFromAccount) Object.assign(body, { name: f.get('name'), phone: f.get('phone'), email: f.get('email') });
  if (kind === 'booking') Object.assign(body, { service_id: f.get('service_id') || null, date: f.get('date'), time: f.get('time') });
  await submitBooking(body, $('#bk-submit'));
});

async function submitBooking(body, btn) {
  btn?.classList.add('loading');
  $('#bk-error').hidden = true;
  try {
    const { booking } = await api('/api/bookings', { method: 'POST', body });
    showSuccess(booking);
  } catch (err) {
    if (err.fields && Object.keys(err.fields).length) {
      if (['name', 'phone', 'email'].some((k) => err.fields[k])) { state.bk.editContact = true; renderContactMode(); }
      applyServerErrors(bkForm, err.fields);
      if (err.fields.time) loadSlots();
    }
    $('#bk-error').textContent = err.message;
    $('#bk-error').hidden = false;
    if (!bkDialog.open) toast(err.message, 'error');
  } finally {
    btn?.classList.remove('loading');
  }
}

function bookingText(b) {
  const lines = [`${b.type === 'consult' ? 'Yêu cầu tư vấn' : 'Đặt lịch'} #${b.id} — ${b.name} (${b.phone})`];
  if (b.date) lines.push(`Thời gian: ${b.time} ngày ${fmtDate(b.date)}`);
  if (b.service_name) lines.push(`Dịch vụ: ${b.service_name}`);
  if (b.design_title) lines.push(`Mẫu: ${b.design_title}`);
  if (b.color_name || b.custom_color) lines.push(`Màu: ${b.color_name || b.custom_color}`);
  if (b.note) lines.push(`Ghi chú: ${b.note}`);
  return lines.join('\n');
}

function showSuccess(b) {
  const s = state.settings;
  const zalo = (s.zaloPhone || '').replace(/\D/g, '');
  const text = bookingText(b);
  const rows = [
    ['Mã yêu cầu', `#${b.id}`],
    ['Khách hàng', `${b.name} · ${b.phone}`],
    b.date && ['Thời gian', `${b.time} · ${fmtDate(b.date)}`],
    b.service_name && ['Dịch vụ', b.service_name],
    b.design_title && ['Mẫu', b.design_title],
    (b.color_name || b.custom_color) && ['Màu', b.color_name || b.custom_color],
  ].filter(Boolean);
  const box = $('#bk-success');
  box.innerHTML = `
    <div class="success-ic">${icon('check', 36)}</div>
    <h3>${b.type === 'consult' ? 'Đã gửi yêu cầu tư vấn!' : 'Đặt lịch thành công!'}</h3>
    <p>Tiệm đã nhận thông tin và sẽ liên hệ xác nhận với bạn sớm nhất.</p>
    <dl class="summary">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${zalo || s.messengerUsername ? `<p class="hint">Muốn được phản hồi nhanh hơn? Gửi thông tin cho tiệm qua:</p>
    <div class="share-row">
      ${zalo ? `<a class="btn btn-zalo" id="share-zalo" href="https://zalo.me/${esc(zalo)}" target="_blank" rel="noopener">${icon('chat', 18)}Gửi qua Zalo</a>` : ''}
      ${s.messengerUsername ? `<a class="btn btn-mess" href="https://m.me/${encodeURIComponent(s.messengerUsername)}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">${icon('send', 18)}Gửi qua Messenger</a>` : ''}
    </div>` : ''}
    <div class="share-row" style="margin-top:10px">
      <button class="btn btn-ghost" id="copy-summary">${icon('copy', 18)}Sao chép thông tin</button>
      <button class="btn btn-primary" data-close>Hoàn tất</button>
    </div>`;
  $('#bk-body').hidden = true;
  box.hidden = false;
  $('#bk-title').textContent = 'Hoàn tất';
  if (!bkDialog.open) openDialog(bkDialog);
  $('[data-close]', box).onclick = () => bkDialog.close();
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast('Đã sao chép thông tin lịch hẹn.', 'success'); return true; } catch { return false; }
  };
  $('#copy-summary').onclick = copy;
  // Zalo has no prefill parameter: copy the summary so the customer can paste it.
  $('#share-zalo')?.addEventListener('click', () => { copy().then((ok) => ok && toast('Đã sao chép — dán vào khung chat Zalo nhé.', 'success', 6000)); });
  $('h3', box).setAttribute('tabindex', '-1');
  $('h3', box).focus();
}

// one-click consult for logged-in members
async function quickConsult(ctx) {
  if (!state.user?.phone) return openBooking({ kind: 'consult', ...ctx });
  const body = { type: 'consult', design_id: ctx.design?.id || null, color_id: ctx.color?.id || null, custom_color: ctx.color ? null : ctx.customColor || null };
  try {
    const { booking } = await api('/api/bookings', { method: 'POST', body });
    if (lb.open) lb.close();
    showSuccess(booking);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ================= auth =================
const authDialog = $('#auth');
let afterAuth = null;
function openAuth(mode = 'login', notice = '', then = null) {
  afterAuth = then;
  setAuthMode(mode);
  const err = $('#login-form .form-error');
  err.hidden = !notice;
  err.textContent = notice;
  openDialog(authDialog);
}
function setAuthMode(mode) {
  for (const t of $$('[data-auth]', authDialog)) t.setAttribute('aria-selected', String(t.dataset.auth === mode));
  $('#login-form').hidden = mode !== 'login';
  $('#register-form').hidden = mode !== 'register';
  $('#auth-title').textContent = mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản';
}
for (const t of $$('[data-auth]', authDialog)) t.onclick = () => setAuthMode(t.dataset.auth);

for (const [formId, url] of [['#login-form', '/api/auth/login'], ['#register-form', '/api/auth/register']]) {
  const form = $(formId);
  liveValidate(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.hidden = true;
    if (!validateForm(form)) return;
    const btn = $('button[type=submit]', form);
    btn.classList.add('loading');
    try {
      const { user } = await api(url, { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      state.user = user;
      authDialog.close();
      form.reset();
      if (user.role === 'admin' && new URLSearchParams(location.search).get('login') === 'admin') { location.href = '/admin'; return; }
      renderAccount();
      toast(`Xin chào, ${user.name}!`, 'success');
      if (history.replaceState && location.search) history.replaceState(null, '', location.pathname + location.hash);
      afterAuth?.();
      afterAuth = null;
    } catch (ex) {
      applyServerErrors(form, ex.fields);
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.classList.remove('loading');
    }
  });
}

// ================= my account =================
const meDialog = $('#me');
async function openMe(tab = 'bookings') {
  setMeTab(tab);
  openDialog(meDialog);
  const pf = $('#profile-form');
  pf.name.value = state.user.name || '';
  pf.phone.value = state.user.phone || '';
  $('#pf-email').value = state.user.email;
  if (tab === 'bookings') loadMyBookings();
}
function setMeTab(tab) {
  for (const t of $$('[data-me]', meDialog)) t.setAttribute('aria-selected', String(t.dataset.me === tab));
  $('#me-bookings').hidden = tab !== 'bookings';
  $('#profile-form').hidden = tab !== 'profile';
}
for (const t of $$('[data-me]', meDialog)) t.onclick = () => { setMeTab(t.dataset.me); if (t.dataset.me === 'bookings') loadMyBookings(); };

async function loadMyBookings() {
  const box = $('#me-bookings');
  box.innerHTML = '<div class="skeleton" style="height:90px"></div>';
  try {
    const { bookings } = await api('/api/bookings/mine');
    if (!bookings.length) {
      box.innerHTML = emptyBox('calendar', 'Chưa có lịch hẹn', 'Chọn một mẫu nail bạn thích và đặt lịch ngay nhé.', '<button class="btn btn-primary" data-book>Đặt lịch ngay</button>');
      return;
    }
    box.innerHTML = `<div class="bk-list">${bookings.map((b) => {
      const st = STATUS[b.status];
      return `<div class="bk-item">
        <div class="top"><span class="when">${b.type === 'consult' ? 'Yêu cầu tư vấn' : `${esc(b.time)} · ${fmtDate(b.date)}`}</span><span class="status ${st.cls}">${st.label}</span></div>
        <div class="sub">#${b.id}${b.service_name ? ' · ' + esc(b.service_name) : ''}${b.design_title ? ' · Mẫu ' + esc(b.design_title) : ''}${b.color_name ? ' · ' + esc(b.color_name) : ''}</div>
        ${['pending', 'confirmed'].includes(b.status) ? `<div class="actions"><button class="link-btn" data-cancel="${b.id}">Hủy yêu cầu</button></div>` : ''}
      </div>`;
    }).join('')}</div>`;
  } catch (e) {
    box.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
  }
}
$('#me-bookings').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cancel]');
  if (!b) return;
  if (!confirm('Bạn chắc chắn muốn hủy lịch hẹn này?')) return;
  try {
    await api(`/api/bookings/${b.dataset.cancel}/cancel`, { method: 'POST' });
    toast('Đã hủy lịch hẹn.', 'success');
    loadMyBookings();
  } catch (err) { toast(err.message, 'error'); }
});

const pf = $('#profile-form');
liveValidate(pf);
pf.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('.form-error', pf);
  err.hidden = true;
  if (!validateForm(pf)) return;
  const btn = $('button[type=submit]', pf);
  btn.classList.add('loading');
  try {
    const { user } = await api('/api/auth/profile', { method: 'PUT', body: Object.fromEntries(new FormData(pf)) });
    state.user = user;
    renderAccount();
    pf.currentPassword.value = pf.newPassword.value = '';
    toast('Đã lưu thông tin.', 'success');
  } catch (ex) {
    if (ex.fields.currentPassword || ex.fields.newPassword) $('.pw-details', pf).open = true;
    applyServerErrors(pf, ex.fields);
    err.textContent = ex.message;
    err.hidden = false;
  } finally { btn.classList.remove('loading'); }
});

// ================= 3D try-on =================
let viewer = null;
function setupTry3D() {
  if (state.settings.show3D === false) return;
  const colors = state.catalog.colors;
  const sw = $('#try-swatches');
  sw.innerHTML = colors.map((c) =>
    `<button type="button" class="swatch finish-${c.finish}" role="radio" aria-checked="false" style="--c:${esc(c.hex)}" data-id="${c.id}" aria-label="${esc(c.name)}" title="${esc(c.name)}"></button>`).join('') +
    `<label class="custom-color" title="Chọn màu bất kỳ"><input type="color" id="try-custom" value="#E9B8B0" aria-label="Chọn màu tự do"></label>`;
  sw.setAttribute('role', 'radiogroup');
  sw.setAttribute('aria-label', 'Màu sơn');
  const first = colors[0];
  if (first) selectTryColor(first); else selectCustom('#E9B8B0');

  const stage = $('#nail-canvas');
  const io = new IntersectionObserver(async ([entry]) => {
    if (!entry.isIntersecting || viewer) return;
    io.disconnect();
    try {
      const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
      if (!gl) throw new Error('no webgl');
      const { createNailViewer } = await import('./nail3d.js');
      viewer = createNailViewer(stage, { color: currentTryHex(), finish: state.try.finish, shape: state.try.shape, french: state.try.french });
    } catch (e) {
      console.warn(e);
      $('#try-fallback').hidden = false;
      $('.try-hint').hidden = true;
    }
  }, { rootMargin: '300px' });
  io.observe(stage);
}
const currentTryHex = () => state.try.color?.hex || state.try.customColor || '#E9B8B0';

function selectTryColor(c) {
  state.try.color = c;
  state.try.customColor = null;
  for (const b of $$('#try-swatches .swatch')) b.setAttribute('aria-checked', String(Number(b.dataset.id) === c.id));
  $('.custom-color')?.classList.remove('active');
  $('#try-color-name').textContent = `— ${c.name}`;
  if (['gloss', 'matte', 'chrome', 'cateye'].includes(c.finish)) setSeg('#try-finish', c.finish);
  viewer?.setColor(c.hex);
}
function selectCustom(hex) {
  state.try.color = null;
  state.try.customColor = hex.toUpperCase();
  for (const b of $$('#try-swatches .swatch')) b.setAttribute('aria-checked', 'false');
  $('.custom-color')?.classList.add('active');
  $('#try-color-name').textContent = `— Màu tự chọn ${hex.toUpperCase()}`;
  viewer?.setColor(hex);
}
function setSeg(sel, v) {
  for (const b of $$(`${sel} button`)) b.setAttribute('aria-pressed', String(b.dataset.v === v));
  if (sel === '#try-finish') { state.try.finish = v; viewer?.setFinish(v); }
  else { state.try.shape = v; viewer?.setShape(v); }
}

// ================= analytics =================
function visitorId() {
  try {
    let id = localStorage.getItem('vid');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('vid', id); }
    return id;
  } catch {
    return (window.__vid ||= crypto.randomUUID?.() || String(Math.random()).slice(2));
  }
}
function track(path = location.pathname, designId) {
  if (window.self !== window.top) return; // admin preview iframe
  const body = JSON.stringify({ visitor: visitorId(), path, referrer: designId ? '' : document.referrer, designId });
  fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

// ================= global wiring =================
function wireUI() {
  document.addEventListener('click', (e) => {
    const t = e.target;
    const accMenu = $('#acc-menu');
    if (accMenu && !accMenu.hidden && !t.closest('#account-slot')) { accMenu.hidden = true; $('#acc-btn').setAttribute('aria-expanded', 'false'); }
    if (t.closest('[data-book]')) { e.preventDefault(); if (meDialog.open) meDialog.close(); openBooking({ kind: 'booking' }); return; }
    if (t.closest('[data-consult]')) { e.preventDefault(); openBooking({ kind: 'consult' }); return; }
    const svc = t.closest('[data-book-service]');
    if (svc) { openBooking({ kind: 'booking', serviceId: svc.dataset.bookService }); return; }
    const card = t.closest('.design-card');
    if (card) { openLightbox(Number(card.dataset.index)); return; }
    const cat = t.closest('[data-cat]');
    if (cat) { state.filter.cat = cat.dataset.cat === 'all' ? 'all' : Number(cat.dataset.cat); renderFilters(); renderDesigns(); return; }
    const col = t.closest('#color-filter [data-color]');
    if (col) {
      const id = Number(col.dataset.color) || null;
      state.filter.color = state.filter.color === id ? null : id;
      renderFilters(); renderDesigns();
      $(`#color-filter [data-color="${state.filter.color || ''}"]`)?.focus();
      return;
    }
    if (t.closest('[data-reset-filter]')) { state.filter = { cat: 'all', color: null }; renderFilters(); renderDesigns(); return; }
    const unpick = t.closest('[data-unpick]');
    if (unpick) {
      if (unpick.dataset.unpick === 'design') state.bk.design = null; else { state.bk.color = null; state.bk.customColor = null; }
      renderPicked();
    }
  });

  // booking dialog controls
  for (const t of $$('[data-kind]', bkDialog)) t.onclick = () => setKind(t.dataset.kind);
  $('#bk-date').addEventListener('change', () => loadSlots(false));
  const slots = $('#bk-slots');
  slots.addEventListener('click', (e) => { const b = e.target.closest('.slot'); if (b && !b.disabled) pickSlot(b); });
  slots.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const all = $$('.slot:not(:disabled)', slots);
    const i = all.indexOf(document.activeElement);
    const n = all[(i + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + all.length) % all.length];
    if (n) { pickSlot(n); n.focus(); }
  });

  // lightbox controls
  $('#lb-prev').onclick = () => stepLightbox(-1);
  $('#lb-next').onclick = () => stepLightbox(1);
  $('.lb-media img', lb).onclick = () => $('.lb-media', lb).classList.toggle('zoomed');
  $('.lb-media', lb).addEventListener('mousemove', (e) => {
    const m = e.currentTarget;
    if (!m.classList.contains('zoomed')) return;
    const r = m.getBoundingClientRect();
    m.querySelector('img').style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
  });
  lb.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    if (e.key === 'ArrowRight') stepLightbox(1);
  });
  let touchX = null;
  lb.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener('touchend', (e) => {
    if (touchX == null || $('.lb-media', lb).classList.contains('zoomed')) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50 && state.list.length > 1) stepLightbox(dx < 0 ? 1 : -1);
    touchX = null;
  });
  const lbCtx = () => {
    const d = state.list[state.lbIndex];
    return { design: d, color: state.catalog.colors.find((c) => c.id === d.color_id) || null };
  };
  $('#lb-book').onclick = () => { const ctx = lbCtx(); lb.close(); openBooking({ kind: 'booking', ...ctx }); };
  $('#lb-consult').onclick = () => { const ctx = lbCtx(); if (!state.user) lb.close(); quickConsult(ctx); };

  // 3D controls
  $('#try-swatches').addEventListener('click', (e) => {
    const b = e.target.closest('.swatch');
    if (b) selectTryColor(state.catalog.colors.find((c) => c.id === Number(b.dataset.id)));
  });
  $('#try-swatches').addEventListener('input', (e) => { if (e.target.id === 'try-custom') selectCustom(e.target.value); });
  for (const b of $$('#try-finish button')) b.onclick = () => setSeg('#try-finish', b.dataset.v);
  for (const b of $$('#try-shape button')) b.onclick = () => setSeg('#try-shape', b.dataset.v);
  $('#try-french').onchange = (e) => { state.try.french = e.target.checked; viewer?.setFrench(e.target.checked); };
  const tryNote = () => {
    const finish = { gloss: 'bóng', matte: 'lì', chrome: 'tráng gương', cateye: 'mắt mèo' }[state.try.finish];
    return `Thử 3D: dáng ${state.try.shape}, hiệu ứng ${finish}${state.try.french ? ', đầu French' : ''}.`;
  };
  $('#try-book').onclick = () => {
    openBooking({ kind: 'booking', color: state.try.color, customColor: state.try.customColor });
    $('#bk-note').value = tryNote();
  };
  $('#try-consult').onclick = () => {
    openBooking({ kind: 'consult', color: state.try.color, customColor: state.try.customColor });
    $('#bk-note').value = tryNote();
  };

  // header, mobile nav, sticky CTA
  const header = $('#header');
  const toggle = $('#nav-toggle');
  const mnav = $('#mobile-nav');
  const setNav = (open) => {
    mnav.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Đóng menu' : 'Mở menu');
    toggle.innerHTML = icon(open ? 'x' : 'menu');
  };
  toggle.onclick = () => setNav(mnav.hidden);
  mnav.addEventListener('click', (e) => { if (e.target.closest('a,button')) setNav(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mnav.hidden) { setNav(false); toggle.focus(); } });

  const mcta = $('.mobile-cta');
  const hero = $('.hero');
  const onScroll = () => {
    header.classList.toggle('scrolled', scrollY > 8);
    mcta.classList.toggle('show', hero.getBoundingClientRect().bottom < 0 && !$('#contact').matches(':hover'));
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const links = $$('.main-nav a');
  const spy = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      for (const a of links) a.classList.toggle('active', a.getAttribute('href') === `#${en.target.id}`);
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  for (const id of ['top', 'services', 'gallery', 'try3d', 'contact']) { const el = document.getElementById(id); if (el) spy.observe(el); }

  // Live preview from the admin "Giao diện" editor (same-origin iframe only).
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.type !== 'preview-settings') return;
    state.settings = { ...state.settings, ...e.data.settings };
    applyTheme(state.settings);
    fillSettings();
    renderContact();
  });
}
