import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v2 pivot: the mailbox table is dropped (its rows have no value) and the
 * webhook-catcher tables are created. `down` restores the v1 `emails` table
 * (empty) so a revert leaves the schema exactly as InitialSchema built it.
 */
export class PivotToWebhooks1791300000000 implements MigrationInterface {
  name = 'PivotToWebhooks1791300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `emails`');

    await queryRunner.query(`
      CREATE TABLE \`endpoints\` (
        \`id\` CHAR(36) NOT NULL,
        \`created_at\` DATETIME(3) NOT NULL,
        \`last_request_at\` DATETIME(3) NULL,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_endpoints_last_request\` (\`last_request_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await queryRunner.query(`
      CREATE TABLE \`requests\` (
        \`id\` CHAR(36) NOT NULL,
        \`endpoint_id\` CHAR(36) NOT NULL,
        \`method\` VARCHAR(16) NOT NULL,
        \`path\` VARCHAR(2048) NOT NULL,
        \`query_params\` JSON NULL,
        \`headers\` JSON NOT NULL,
        \`client_ip\` VARCHAR(45) NULL,
        \`content_type\` VARCHAR(255) NULL,
        \`content_kind\` ENUM('none', 'json', 'form', 'multipart', 'html', 'xml', 'text', 'binary') NOT NULL,
        \`body\` MEDIUMTEXT NULL,
        \`form_fields\` JSON NULL,
        \`dropped_files\` JSON NULL,
        \`size_bytes\` INT UNSIGNED NOT NULL,
        \`received_at\` DATETIME(3) NOT NULL,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_requests_endpoint_received\` (\`endpoint_id\`, \`received_at\`),
        INDEX \`idx_requests_received\` (\`received_at\`),
        CONSTRAINT \`fk_requests_endpoint\` FOREIGN KEY (\`endpoint_id\`)
          REFERENCES \`endpoints\` (\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `requests`');
    await queryRunner.query('DROP TABLE `endpoints`');

    // Same definition as InitialSchema1759650000000 so revert is a true inverse.
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
  }
}
