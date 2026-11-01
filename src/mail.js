// Email through the Resend HTTP API. Render's free plan blocks the SMTP ports, so the mailbox's own SMTP can't be used.
const SITE_URL = 'https://iyunailart.com';
const BRAND = 'IYU Nail Art Studio';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendMail(s, { to, subject, html, text, replyTo, key }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.notifyResendKey}`,
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify({ from: s.notifyMailFrom, to, subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
}

// The automatic reply a customer receives. The note is left out on purpose: the address is unverified,
// so nothing free-form may be relayed to it through the salon's domain.
function customerEmail(b, s) {
  const consult = b.type === 'consult';
  const heading = consult ? 'Chúng tôi đã nhận yêu cầu tư vấn của bạn' : 'Chúng tôi đã nhận lịch hẹn của bạn';
  const next = consult
    ? `${BRAND} sẽ liên hệ với bạn qua Zalo số ${b.phone} trong thời gian sớm nhất ạ.`
    : `Lịch hẹn đang chờ tiệm xác nhận. ${BRAND} sẽ liên hệ qua Zalo số ${b.phone} nếu cần thay đổi ạ.`;
  const rows = [
    ['Mã đơn', `#${b.id}`],
    ['Khách hàng', b.name],
    ['Số điện thoại', b.phone],
    b.date && ['Thời gian', `${b.time} ngày ${b.date.split('-').reverse().join('/')}`],
    b.service_name && ['Dịch vụ', b.service_name],
    b.design_title && ['Mẫu', b.design_title],
    (b.color_name || b.custom_color) && ['Màu', b.color_name || `Màu tự chọn ${b.custom_color}`],
  ].filter(Boolean);
  const contact = [s.phone && `Điện thoại: ${s.phone}`, s.address && `Địa chỉ: ${s.address}`, s.hours && `Giờ mở cửa: ${s.hours}`].filter(Boolean);

  const text = [
    `Xin chào ${b.name},`, '', `${heading}.`, ...rows.map(([k, v]) => `${k}: ${v}`), '', next, '',
    BRAND, ...contact, SITE_URL,
  ].join('\n');

  const color = esc(s.primaryColor);
  const html = `<!doctype html><html lang="vi"><body style="margin:0;padding:24px 12px;background:#f6f1ee;font-family:Arial,Helvetica,sans-serif;color:#2e1a24">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px">
<tr><td style="padding:20px 28px;border-bottom:3px solid ${color}">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:14px"><img src="${SITE_URL}/images/logo-email.png" width="79" height="56" alt="IYU" style="display:block;border:0"></td>
<td style="font-size:20px;font-weight:bold;color:${color}">IYU Nail Art</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 28px 8px;font-size:15px;line-height:1.6">
<p style="margin:0 0 12px">Xin chào <strong>${esc(b.name)}</strong>,</p>
<p style="margin:0 0 16px;font-size:18px;font-weight:bold">${esc(heading)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#7a6570;width:120px">${esc(k)}</td><td style="padding:6px 0;font-weight:bold">${esc(v)}</td></tr>`).join('\n')}
</table>
<p style="margin:16px 0">${esc(next)}</p>
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #eee3dd;font-size:13px;line-height:1.7;color:#7a6570">
${contact.map((c) => `${esc(c)}<br>`).join('\n')}
<a href="${SITE_URL}" style="color:${color}">${SITE_URL.replace('https://', '')}</a>
</td></tr>
</table></body></html>`;

  const subject = `${BRAND}: đã nhận ${consult ? 'yêu cầu tư vấn' : 'lịch hẹn'} #${b.id}`;
  return { subject, html, text };
}

module.exports = { sendMail, customerEmail };
