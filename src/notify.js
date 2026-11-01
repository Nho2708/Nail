// Sends new booking / consultation requests to the admin on every configured channel,
// and an automatic confirmation to the customer's email.
// Channels are configured in Admin → Thông báo. Unconfigured channels are skipped.
const { getSettings, one } = require('./db');
const { sendMail, customerEmail, changeEmail } = require('./mail');

const MAX_CUSTOMER_MAILS_PER_DAY = 3;

function formatMessage(b) {
  const lines = [
    b.type === 'consult' ? '💬 YÊU CẦU TƯ VẤN MỚI' : '📅 LỊCH HẸN MỚI',
    `#${b.id} · ${b.name} · ${b.phone}`,
  ];
  if (b.email) lines.push(`Email: ${b.email}`);
  if (b.date) lines.push(`Thời gian: ${b.time} ngày ${b.date.split('-').reverse().join('/')}`);
  if (b.service_name) lines.push(`Dịch vụ: ${b.service_name}`);
  if (b.design_title) lines.push(`Mẫu: ${b.design_title}`);
  if (b.color_name) lines.push(`Màu: ${b.color_name}`);
  else if (b.custom_color) lines.push(`Màu tự chọn: ${b.custom_color}`);
  if (b.note) lines.push(`Ghi chú: ${b.note}`);
  lines.push(b.user_id ? 'Khách có tài khoản' : 'Khách vãng lai');
  return lines.join('\n');
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  // Zalo returns 200 with {error: <non-zero>} on failure
  try {
    const j = JSON.parse(text);
    if (typeof j.error === 'number' && j.error !== 0) throw new Error(`Zalo error ${j.error}: ${j.message}`);
  } catch (e) { if (e.message.startsWith('Zalo')) throw e; }
  return text;
}

const channels = {
  telegram: (s, text) => s.notifyTelegramToken && s.notifyTelegramChatId &&
    post(`https://api.telegram.org/bot${s.notifyTelegramToken}/sendMessage`, { chat_id: s.notifyTelegramChatId, text }),

  // Zalo Official Account API v3 — gửi tin tư vấn tới user_id đã quan tâm OA.
  zalo: (s, text) => s.notifyZaloOaToken && s.notifyZaloUserId &&
    post('https://openapi.zalo.me/v3.0/oa/message/cs',
      { recipient: { user_id: s.notifyZaloUserId }, message: { text } },
      { access_token: s.notifyZaloOaToken }),

  // Facebook Messenger Send API — admin phải từng nhắn tin cho Page (PSID) và trong cửa sổ 24h.
  messenger: (s, text) => s.notifyMessengerPageToken && s.notifyMessengerPsid &&
    post(`https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(s.notifyMessengerPageToken)}`,
      { recipient: { id: s.notifyMessengerPsid }, messaging_type: 'UPDATE', message: { text } }),

  webhook: (s, text, b) => s.notifyWebhookUrl && post(s.notifyWebhookUrl, { text, booking: b }),

  // The salon's OxMail mailbox files mail "from" its own domain sent through Resend as Junk, and Junk is not
  // forwarded, so alerts should go straight to an outside address (notifyAlertEmail).
  email: (s, text, b) => s.notifyResendKey && s.notifyMailFrom && (s.notifyAlertEmail || s.notifySalonEmail) &&
    sendMail(s, { to: s.notifyAlertEmail || s.notifySalonEmail, subject: text.split('\n').slice(0, 2).join(' '), text, replyTo: b.email }),
};

async function notifyAdmin(booking, only) {
  const s = await getSettings({ includePrivate: true });
  const text = formatMessage(booking);
  const result = {};
  await Promise.all(Object.entries(channels).map(async ([name, send]) => {
    if (only && only !== name) return;
    try {
      const r = send(s, text, booking);
      if (!r) { result[name] = 'skipped'; return; }
      await r;
      result[name] = 'ok';
    } catch (e) {
      result[name] = 'error: ' + e.message;
      console.warn(`[notify:${name}]`, e.message);
    }
  }));
  return result;
}

// The form accepts any address, so repeats are capped to stop it being used to flood someone's inbox.
async function notifyCustomer(booking) {
  if (!booking.email) return 'skipped';
  const s = await getSettings({ includePrivate: true });
  if (!s.notifyResendKey || !s.notifyMailFrom) return 'skipped';
  try {
    const { n } = await one(`SELECT COUNT(*) AS n FROM bookings WHERE email = @email AND created_at > now() - interval '1 day'`, { email: booking.email });
    if (n > MAX_CUSTOMER_MAILS_PER_DAY) return 'skipped';
    await sendMail(s, { to: booking.email, replyTo: s.notifySalonEmail, key: booking.id ? `booking-${booking.id}` : undefined, ...customerEmail(booking, s) });
    return 'ok';
  } catch (e) {
    console.warn('[notify:customer]', e.message);
    return 'error: ' + e.message;
  }
}

// Confirmation, reschedule or cancellation by the salon. Started by the admin, so no daily cap.
async function notifyBookingChange(kind, booking, before) {
  if (!booking.email) return 'skipped';
  const s = await getSettings({ includePrivate: true });
  if (!s.notifyResendKey || !s.notifyMailFrom) return 'skipped';
  try {
    await sendMail(s, { to: booking.email, replyTo: s.notifySalonEmail, ...changeEmail(kind, booking, s, before) });
    return 'ok';
  } catch (e) {
    console.warn('[notify:customer]', e.message);
    return 'error: ' + e.message;
  }
}

module.exports = { notifyAdmin, notifyCustomer, notifyBookingChange, formatMessage };
