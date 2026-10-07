import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CaughtMail } from './caught-mail.entity';

export type { CaughtMail } from './caught-mail.entity';

/** Messages kept in `caught_mails`; the oldest are dropped on insert beyond this. */
export const MAX_CAUGHT_MAILS = 200;
const LINK_REGEX = /https?:\/\/[^\s<>"']+/g;

export interface IncomingMail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Inbox of the dev mail catcher, read through /devmailcatcher
 * (DevMailCatcherController). Fed by MailService outside production and by
 * POST /devmailcatcher/messages.json everywhere (other applications under
 * development). DB-backed so every Passenger process sees the same messages.
 * Newest first, bounded to MAX_CAUGHT_MAILS rows.
 */
@Injectable()
export class DevMailboxService {
  constructor(@InjectRepository(CaughtMail) private readonly mails: Repository<CaughtMail>) {}

  async store(mail: IncomingMail): Promise<CaughtMail> {
    const row = this.mails.create({
      id: randomBytes(6).toString('hex'),
      sentAt: new Date(),
      links: extractLinks(mail.text, mail.html),
      ...mail,
    });
    await this.mails.insert(row);
    await this.enforceCap();
    return row;
  }

  /** Newest first; `to` filters on the exact recipient address (collation-insensitive). */
  list(to?: string): Promise<CaughtMail[]> {
    const wanted = to?.trim();
    return this.mails.find({
      where: wanted ? { to: wanted } : {},
      order: { sentAt: 'DESC', id: 'DESC' },
      take: MAX_CAUGHT_MAILS,
    });
  }

  get(id: string): Promise<CaughtMail | null> {
    return this.mails.findOneBy({ id });
  }

  async clear(): Promise<number> {
    const result = await this.mails.createQueryBuilder().delete().from(CaughtMail).execute();
    return result.affected ?? 0;
  }

  private async enforceCap(): Promise<void> {
    const count = await this.mails.count();
    if (count <= MAX_CAUGHT_MAILS) return;
    // MySQL forbids selecting from the target table in a DELETE subquery unless it is
    // wrapped in a derived table, hence the inner SELECT ... FROM (...) t.
    await this.mails.query(
      'DELETE FROM `caught_mails` WHERE `id` NOT IN (' +
        'SELECT `id` FROM (SELECT `id` FROM `caught_mails` ORDER BY `sent_at` DESC, `id` DESC LIMIT ?) t)',
      [MAX_CAUGHT_MAILS],
    );
  }
}

function extractLinks(text: string, html: string): string[] {
  const found = [...(text.match(LINK_REGEX) ?? []), ...(html.match(LINK_REGEX) ?? [])];
  return [...new Set(found)];
}
