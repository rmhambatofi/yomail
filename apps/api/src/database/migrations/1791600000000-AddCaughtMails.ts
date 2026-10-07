import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dev mail catcher moved from process memory to the database (2026-10-07) so it
 * works in production across Passenger processes: other applications push their
 * emails to it, admins read them.
 */
export class AddCaughtMails1791600000000 implements MigrationInterface {
  name = 'AddCaughtMails1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`caught_mails\` (
        \`id\` CHAR(12) NOT NULL,
        \`to_address\` VARCHAR(320) NOT NULL,
        \`from_address\` VARCHAR(320) NOT NULL,
        \`subject\` VARCHAR(998) NOT NULL,
        \`text\` MEDIUMTEXT NOT NULL,
        \`html\` MEDIUMTEXT NOT NULL,
        \`links\` JSON NOT NULL,
        \`sent_at\` DATETIME(3) NOT NULL,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_caught_mails_sent\` (\`sent_at\`),
        INDEX \`idx_caught_mails_to\` (\`to_address\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `caught_mails`');
  }
}
