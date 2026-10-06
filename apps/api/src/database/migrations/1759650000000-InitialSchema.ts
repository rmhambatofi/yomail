import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1759650000000 implements MigrationInterface {
  name = 'InitialSchema1759650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`emails\` (
        \`id\` CHAR(36) NOT NULL,
        \`local_part\` VARCHAR(64) NOT NULL,
        \`recipient\` VARCHAR(255) NOT NULL,
        \`from_address\` VARCHAR(255) NOT NULL,
        \`from_name\` VARCHAR(255) NULL,
        \`subject\` VARCHAR(998) NULL,
        \`text_body\` MEDIUMTEXT NULL,
        \`html_body\` MEDIUMTEXT NULL,
        \`html_sanitized\` MEDIUMTEXT NULL,
        \`raw_mime\` MEDIUMBLOB NOT NULL,
        \`size_bytes\` INT UNSIGNED NOT NULL,
        \`has_attachments\` TINYINT NOT NULL DEFAULT 0,
        \`message_id\` VARCHAR(255) NULL,
        \`received_at\` DATETIME(3) NOT NULL,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_emails_local_received\` (\`local_part\`, \`received_at\` DESC),
        INDEX \`idx_emails_received\` (\`received_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await queryRunner.query(`
      CREATE TABLE \`settings\` (
        \`key\` VARCHAR(64) NOT NULL,
        \`value\` VARCHAR(255) NOT NULL,
        PRIMARY KEY (\`key\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `settings`');
    await queryRunner.query('DROP TABLE `emails`');
  }
}
