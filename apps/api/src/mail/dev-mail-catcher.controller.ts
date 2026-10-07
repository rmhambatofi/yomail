import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { Env } from '../config/env';
import { isProduction } from '../config/env';
import { DevMailboxService, MAX_CAUGHT_MAILS } from './dev-mailbox.service';
import type { CaughtMail } from './dev-mailbox.service';
import { caughtMailSchema } from './schemas';
import type { CaughtMailBody } from './schemas';
import { escapeHtml } from './templates';

/** Fixed path, at the site root (outside the API prefix), in every environment. */
export const DEV_MAIL_CATCHER_PATH = 'devmailcatcher';
/** Literal route strings, excluded from the global prefix exactly like the capture routes. */
export const DEV_MAIL_CATCHER_ROUTES = [
  DEV_MAIL_CATCHER_PATH,
  `${DEV_MAIL_CATCHER_PATH}/messages.json`,
  `${DEV_MAIL_CATCHER_PATH}/:id`,
  `${DEV_MAIL_CATCHER_PATH}/:id/html`,
];

/**
 * Developer inbox. Outside production every email the app "sends" lands here (see
 * MailService); in every environment, production included, other applications under
 * development push their emails with `POST messages.json`. HTML pages for humans,
 * `messages.json?to=` for scripts. Reserved to ADMIN sessions (401 without a session,
 * 403 for a STANDARD member): the messages hold confirmation and reset links.
 */
@Controller(DEV_MAIL_CATCHER_PATH)
@UseGuards(AuthGuard, RolesGuard)
@Roles('ADMIN')
export class DevMailCatcherController {
  private readonly production: boolean;

  constructor(
    private readonly mailbox: DevMailboxService,
    config: ConfigService<Env, true>,
  ) {
    this.production = isProduction(config.get('NODE_ENV', { infer: true }));
  }

  @Get('messages.json')
  listJson(@Query('to') to?: string): Promise<CaughtMail[]> {
    return this.mailbox.list(to);
  }

  /** Ingest: another application hands over an email instead of sending it. */
  @Post('messages.json')
  @HttpCode(201)
  push(@Body(new ZodValidationPipe(caughtMailSchema)) body: CaughtMailBody): Promise<CaughtMail> {
    return this.mailbox.store(body);
  }

  @Delete()
  @HttpCode(204)
  async clear(): Promise<void> {
    await this.mailbox.clear();
  }

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  async index(): Promise<string> {
    const rows = (await this.mailbox.list())
      .map(
        (m) => `<tr>
  <td class="mono">${escapeHtml(m.sentAt.toISOString().replace('T', ' ').slice(0, 19))}</td>
  <td>${escapeHtml(m.to)}</td>
  <td><a href="/${DEV_MAIL_CATCHER_PATH}/${m.id}">${escapeHtml(m.subject) || '(no subject)'}</a></td>
  <td>${m.links.map((l) => `<a href="${escapeHtml(l)}">open link</a>`).join(' ')}</td>
</tr>`,
      )
      .join('\n');
    const source = this.production
      ? 'This server sends its own emails through SMTP; this inbox holds the messages other applications push to it'
      : 'Every email this app would send in this environment ends up here instead (nothing leaves the machine), as do the messages other applications push to it';
    return page(
      'Dev mail catcher',
      `<p class="muted">${source} with <code>POST /${DEV_MAIL_CATCHER_PATH}/messages.json</code> (JSON <code>{ to, subject, from?, text?, html? }</code>, admin session). Newest first, the last ${MAX_CAUGHT_MAILS} messages are kept.
<a href="/${DEV_MAIL_CATCHER_PATH}/messages.json">messages.json</a> ·
<button type="button" onclick="fetch(location.pathname,{method:'DELETE'}).then(()=>location.reload())">Clear all</button></p>
${
  rows
    ? `<table><thead><tr><th>Sent</th><th>To</th><th>Subject</th><th>Links</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p>No email captured yet.</p>'
}`,
    );
  }

  @Get(':id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async detail(@Param('id') id: string): Promise<string> {
    const m = await this.find(id);
    return page(
      m.subject || '(no subject)',
      `<p><a href="/${DEV_MAIL_CATCHER_PATH}">← all messages</a></p>
<table class="meta">
<tr><th>From</th><td>${escapeHtml(m.from) || '—'}</td></tr>
<tr><th>To</th><td>${escapeHtml(m.to)}</td></tr>
<tr><th>Subject</th><td>${escapeHtml(m.subject) || '—'}</td></tr>
<tr><th>Sent</th><td class="mono">${escapeHtml(m.sentAt.toISOString())}</td></tr>
<tr><th>Links</th><td>${m.links.map((l) => `<a href="${escapeHtml(l)}">${escapeHtml(l)}</a>`).join('<br>') || '—'}</td></tr>
</table>
<h2>Text</h2>
<pre>${escapeHtml(m.text)}</pre>
<h2>HTML</h2>
<iframe sandbox="" src="/${DEV_MAIL_CATCHER_PATH}/${m.id}/html" title="HTML version"></iframe>`,
    );
  }

  /** The HTML body alone, shown in the sandboxed iframe of the detail page. */
  @Get(':id/html')
  async html(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const m = await this.find(id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send(m.html);
  }

  private async find(id: string): Promise<CaughtMail> {
    const m = /^[0-9a-f]{12}$/.test(id) ? await this.mailbox.get(id) : null;
    if (!m) throw new NotFoundException('Message not found');
    return m;
  }
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)} — yomail dev mail catcher</title>
<style>
body{font-family:system-ui,sans-serif;margin:24px;color:#0f172a;max-width:1100px}
h1{font-size:20px}h2{font-size:15px;margin-top:24px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-size:14px}
th{color:#475569;font-weight:600}.meta th{width:90px}.mono{font-family:ui-monospace,monospace;font-size:13px;white-space:nowrap}
.muted{color:#64748b;font-size:14px}a{color:#0369a1}pre{background:#f8fafc;border:1px solid #e2e8f0;padding:12px;white-space:pre-wrap;word-break:break-word;font-size:13px}
code{font-family:ui-monospace,monospace;font-size:13px;background:#f1f5f9;padding:1px 4px;border-radius:3px}
iframe{width:100%;height:520px;border:1px solid #e2e8f0;background:#fff}
button{font:inherit;font-size:13px;padding:2px 8px}
</style>
</head>
<body>
<h1>yomail dev mail catcher</h1>
${body}
</body>
</html>`;
}
