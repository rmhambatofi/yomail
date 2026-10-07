import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 7 (user accounts): users, sessions, single-use email tokens, and an
 * optional owner on endpoints. Everything is named explicitly (FKs, indexes)
 * so `migration:generate` sees no diff against the entities.
 */
export class AddUsers1791400000000 implements MigrationInterface {
  name = 'AddUsers1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`users\` (
        \`id\` CHAR(36) NOT NULL,
        \`username\` VARCHAR(32) NOT NULL,
        \`email\` VARCHAR(254) NOT NULL,
        \`password_hash\` VARCHAR(255) NOT NULL,
        \`status\` ENUM('DISABLED', 'ENABLED', 'DELETED') NOT NULL DEFAULT 'DISABLED',
        \`role\` ENUM('ADMIN', 'STANDARD') NOT NULL DEFAULT 'STANDARD',
        \`created_at\` DATETIME(3) NOT NULL,
        \`updated_at\` DATETIME(3) NOT NULL,
        \`enabled_at\` DATETIME(3) NULL,
        \`deleted_at\` DATETIME(3) NULL,
        \`last_login_at\` DATETIME(3) NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`uq_users_username\` (\`username\`),
        UNIQUE INDEX \`uq_users_email\` (\`email\`),
        INDEX \`idx_users_status_created\` (\`status\`, \`created_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await queryRunner.query(`
      CREATE TABLE \`sessions\` (
        \`id\` CHAR(36) NOT NULL,
        \`user_id\` CHAR(36) NOT NULL,
        \`token_hash\` CHAR(64) NOT NULL,
        \`created_at\` DATETIME(3) NOT NULL,
        \`last_seen_at\` DATETIME(3) NOT NULL,
        \`expires_at\` DATETIME(3) NOT NULL,
        \`user_agent\` VARCHAR(255) NULL,
        \`ip\` VARCHAR(45) NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`uq_sessions_token\` (\`token_hash\`),
        INDEX \`idx_sessions_user\` (\`user_id\`),
        INDEX \`idx_sessions_expires\` (\`expires_at\`),
        CONSTRAINT \`fk_sessions_user\` FOREIGN KEY (\`user_id\`)
          REFERENCES \`users\` (\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await queryRunner.query(`
      CREATE TABLE \`user_tokens\` (
        \`id\` CHAR(36) NOT NULL,
        \`user_id\` CHAR(36) NOT NULL,
        \`kind\` ENUM('CONFIRM_EMAIL', 'RESET_PASSWORD') NOT NULL,
        \`token_hash\` CHAR(64) NOT NULL,
        \`created_at\` DATETIME(3) NOT NULL,
        \`expires_at\` DATETIME(3) NOT NULL,
        \`used_at\` DATETIME(3) NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`uq_user_tokens_token\` (\`token_hash\`),
        INDEX \`idx_user_tokens_user\` (\`user_id\`),
        INDEX \`idx_user_tokens_expires\` (\`expires_at\`),
        CONSTRAINT \`fk_user_tokens_user\` FOREIGN KEY (\`user_id\`)
          REFERENCES \`users\` (\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await queryRunner.query('ALTER TABLE `endpoints` ADD `owner_id` CHAR(36) NULL');
    await queryRunner.query('CREATE INDEX `idx_endpoints_owner` ON `endpoints` (`owner_id`)');
    await queryRunner.query(`
      ALTER TABLE \`endpoints\`
        ADD CONSTRAINT \`fk_endpoints_owner\` FOREIGN KEY (\`owner_id\`)
        REFERENCES \`users\` (\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `endpoints` DROP FOREIGN KEY `fk_endpoints_owner`');
    await queryRunner.query('DROP INDEX `idx_endpoints_owner` ON `endpoints`');
    await queryRunner.query('ALTER TABLE `endpoints` DROP COLUMN `owner_id`');
    await queryRunner.query('DROP TABLE `user_tokens`');
    await queryRunner.query('DROP TABLE `sessions`');
    await queryRunner.query('DROP TABLE `users`');
  }
}
