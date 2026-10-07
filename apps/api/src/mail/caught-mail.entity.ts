import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A message held by the dev mail catcher (/devmailcatcher). Outside production every
 * email yomail would send lands here instead of being delivered; in every environment
 * other applications may push messages through POST /devmailcatcher/messages.json.
 * Stored in the database, not in memory, because Passenger runs several processes
 * and the browser of the admin may hit a different one than the application posting.
 */
@Entity({ name: 'caught_mails' })
@Index('idx_caught_mails_sent', ['sentAt'])
@Index('idx_caught_mails_to', ['to'])
export class CaughtMail {
  /** 12 hex characters (randomBytes(6)). */
  @PrimaryColumn({ name: 'id', type: 'char', length: 12 })
  id: string;

  @Column({ name: 'to_address', type: 'varchar', length: 320 })
  to: string;

  @Column({ name: 'from_address', type: 'varchar', length: 320 })
  from: string;

  @Column({ name: 'subject', type: 'varchar', length: 998 })
  subject: string;

  @Column({ name: 'text', type: 'mediumtext' })
  text: string;

  @Column({ name: 'html', type: 'mediumtext' })
  html: string;

  /** Every http(s) link found in the text (then the HTML) version, in order, deduplicated. */
  @Column({ name: 'links', type: 'json' })
  links: string[];

  @Column({ name: 'sent_at', type: 'datetime', precision: 3 })
  sentAt: Date;
}
