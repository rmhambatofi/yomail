import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { Env } from '../config/env';
import { isProduction } from '../config/env';
import { DEV_MAIL_CATCHER_PATH } from './dev-mail-catcher.controller';
import { DevMailboxService } from './dev-mailbox.service';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends transactional emails. The backend follows the environment, not a
 * setting: in production (`NODE_ENV=production`) messages go through the SMTP
 * server configured by SMTP_*; anywhere else they are stored by the dev mail
 * catcher (DevMailboxService, read at /devmailcatcher), so no email ever leaves
 * a development or test machine. The catcher itself exists in every environment
 * (other applications push to it); production emails of this app never go there.
 * send() never throws: a delivery failure is logged and reported as `false`,
 * callers decide what to do (sign-up still succeeds, "Resend" exists).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly from: string;
  /** Null outside production: the dev mail catcher takes over. */
  private readonly smtp: Transporter | null;

  constructor(
    private readonly devMailbox: DevMailboxService,
    config: ConfigService<Env, true>,
  ) {
    this.from = config.get('MAIL_FROM', { infer: true });
    if (isProduction(config.get('NODE_ENV', { infer: true }))) {
      const user = config.get('SMTP_USER', { infer: true });
      this.smtp = createTransport({
        host: config.get('SMTP_HOST', { infer: true }),
        port: config.get('SMTP_PORT', { infer: true }),
        secure: config.get('SMTP_SECURE', { infer: true }) === 1,
        auth: user ? { user, pass: config.get('SMTP_PASSWORD', { infer: true }) } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
    } else {
      this.smtp = null;
      this.logger.log(`non-production environment: emails are caught at /${DEV_MAIL_CATCHER_PATH}`);
    }
  }

  /** Resolves to true when the backend accepted the message. */
  async send(mail: OutgoingMail): Promise<boolean> {
    if (!this.smtp) {
      const caught = await this.devMailbox.store({ from: this.from, ...mail });
      this.logger.log(
        `caught "${mail.subject}" to ${mail.to}: /${DEV_MAIL_CATCHER_PATH}/${caught.id}` +
          (caught.links.length ? ` (${caught.links.join(' ')})` : ''),
      );
      return true;
    }
    try {
      const info = await this.smtp.sendMail({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      this.logger.log(`sent "${mail.subject}" to ${mail.to} (${info.messageId})`);
      return true;
    } catch (err) {
      this.logger.error(
        `failed to send "${mail.subject}" to ${mail.to}: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
