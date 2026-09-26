// Shared validation rules — mirrored client-side in public/js/validate.js.
const PHONE_RE = /^(0|\+84)(3|5|7|8|9)\d{8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const normPhone = (p) => clean(p).replace(/[\s.-]/g, '');

function todayLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function validateBooking(body, { openTime = '09:00', closeTime = '19:30', requireService = true } = {}) {
  const errors = {};
  const type = body.type === 'consult' ? 'consult' : 'booking';
  const data = {
    type,
    name: clean(body.name),
    phone: normPhone(body.phone),
    email: clean(body.email).toLowerCase(),
    date: clean(body.date),
    time: clean(body.time),
    note: clean(body.note),
    service_id: body.service_id ? Number(body.service_id) : null,
    design_id: body.design_id ? Number(body.design_id) : null,
    color_id: body.color_id ? Number(body.color_id) : null,
    custom_color: clean(body.custom_color) || null,
  };

  if (data.name.length < 2 || data.name.length > 60) errors.name = 'Họ tên phải từ 2 đến 60 ký tự.';
  else if (/[<>{}\d]/.test(data.name)) errors.name = 'Họ tên không được chứa số hoặc ký tự đặc biệt.';
  if (!PHONE_RE.test(data.phone)) errors.phone = 'Số điện thoại Việt Nam không hợp lệ (VD: 0901234567).';
  if (data.email && !EMAIL_RE.test(data.email)) errors.email = 'Email không hợp lệ.';
  if (data.note.length > 500) errors.note = 'Ghi chú tối đa 500 ký tự.';
  if (data.custom_color && !/^#[0-9a-f]{6}$/i.test(data.custom_color)) errors.custom_color = 'Mã màu không hợp lệ.';

  if (type === 'booking') {
    if (!DATE_RE.test(data.date)) errors.date = 'Vui lòng chọn ngày hẹn.';
    else {
      const today = todayLocal();
      const max = new Date(Date.parse(today + 'T00:00:00Z') + 60 * 86400000).toISOString().slice(0, 10);
      if (data.date < today) errors.date = 'Ngày hẹn không được ở quá khứ.';
      else if (data.date > max) errors.date = 'Chỉ nhận đặt lịch trong vòng 60 ngày tới.';
    }
    if (!TIME_RE.test(data.time)) errors.time = 'Vui lòng chọn giờ hẹn.';
    else if (data.time < openTime || data.time > closeTime) errors.time = `Giờ hẹn phải trong khoảng ${openTime} – ${closeTime}.`;
    else if (!errors.date && data.date === todayLocal()) {
      const now = new Date();
      const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (data.time <= hm) errors.time = 'Giờ hẹn hôm nay đã qua, vui lòng chọn giờ khác.';
    }
    if (requireService && !data.service_id) errors.service_id = 'Vui lòng chọn dịch vụ.';
  } else {
    data.date = null;
    data.time = null;
  }
  return { data, errors, ok: Object.keys(errors).length === 0 };
}

function validateRegister(body) {
  const errors = {};
  const data = {
    name: clean(body.name),
    email: clean(body.email).toLowerCase(),
    phone: normPhone(body.phone),
    password: String(body.password || ''),
  };
  if (data.name.length < 2 || data.name.length > 60) errors.name = 'Họ tên phải từ 2 đến 60 ký tự.';
  if (!EMAIL_RE.test(data.email)) errors.email = 'Email không hợp lệ.';
  if (!PHONE_RE.test(data.phone)) errors.phone = 'Số điện thoại Việt Nam không hợp lệ.';
  if (data.password.length < 8 || !/[A-Za-z]/.test(data.password) || !/\d/.test(data.password))
    errors.password = 'Mật khẩu tối thiểu 8 ký tự, gồm cả chữ và số.';
  return { data, errors, ok: Object.keys(errors).length === 0 };
}

module.exports = { validateBooking, validateRegister, PHONE_RE, EMAIL_RE, normPhone, clean, todayLocal };
