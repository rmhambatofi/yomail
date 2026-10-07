/**
 * Transactional emails, built in code (no template engine). Text and HTML
 * versions carry the same content. The only user-provided value injected is
 * the username, HTML-escaped; links are generated server-side.
 */

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

const APP_NAME = 'yomail';

export function confirmEmail(params: {
  username: string;
  link: string;
  ttlHours: number;
}): MailContent {
  const { username, link, ttlHours } = params;
  const subject = `Confirm your ${APP_NAME} account`;
  const intro = `Hi ${username}, thanks for signing up. Click the button below to activate your account.`;
  const validity = `This link is valid for ${ttlHours} hours.`;
  const footer = 'If you did not create an account, ignore this email.';
  return {
    subject,
    text: [intro, '', link, '', validity, footer].join('\n'),
    html: layout({
      title: subject,
      paragraphs: [intro],
      button: { label: 'Activate my account', link },
      after: [validity, footer],
    }),
  };
}

export function resetPassword(params: {
  username: string;
  link: string;
  ttlMinutes: number;
}): MailContent {
  const { username, link, ttlMinutes } = params;
  const subject = `Reset your ${APP_NAME} password`;
  const intro = `Hi ${username}, someone asked to reset the password of your account. Click the button below to choose a new one.`;
  const validity = `This link is valid for ${ttlMinutes} minutes.`;
  const footer = 'If you did not ask for this, ignore this email: your password stays unchanged.';
  return {
    subject,
    text: [intro, '', link, '', validity, footer].join('\n'),
    html: layout({
      title: subject,
      paragraphs: [intro],
      button: { label: 'Choose a new password', link },
      after: [validity, footer],
    }),
  };
}

function layout(opts: {
  title: string;
  paragraphs: string[];
  button: { label: string; link: string };
  after: string[];
}): string {
  const p = (s: string, muted = false) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:${muted ? '#64748b' : '#0f172a'}">${escapeHtml(s)}</p>`;
  const href = escapeHtml(opts.button.link);
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(opts.title)}</title></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px">
<tr><td style="padding:28px 28px 8px">
<p style="margin:0 0 20px;font-size:18px;font-weight:700;color:#0f172a">${APP_NAME}</p>
${opts.paragraphs.map((s) => p(s)).join('\n')}
<p style="margin:8px 0 24px"><a href="${href}" style="display:inline-block;padding:12px 20px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:600">${escapeHtml(opts.button.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#64748b">Or paste this link in your browser:<br><a href="${href}" style="color:#334155;word-break:break-all">${href}</a></p>
${opts.after.map((s) => p(s, true)).join('\n')}
</td></tr>
</table>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
