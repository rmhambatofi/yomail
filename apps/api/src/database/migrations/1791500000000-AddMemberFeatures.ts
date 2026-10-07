import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 8 (member features): display name and configurable response on
 * endpoints, free-text note on requests, and the members' retention setting.
 */
export class AddMemberFeatures1791500000000 implements MigrationInterface {
  name = 'AddMemberFeatures1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `endpoints` ADD `name` VARCHAR(80) NULL');
    await queryRunner.query('ALTER TABLE `endpoints` ADD `response_config` JSON NULL');
    await queryRunner.query('ALTER TABLE `requests` ADD `note` TEXT NULL');
    await queryRunner.query(
      "INSERT INTO `settings` (`key`, `value`) VALUES ('retention_days_members', '30') " +
        'ON DUPLICATE KEY UPDATE `key` = `key`',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM `settings` WHERE `key` = 'retention_days_members'");
    await queryRunner.query('ALTER TABLE `requests` DROP COLUMN `note`');
    await queryRunner.query('ALTER TABLE `endpoints` DROP COLUMN `response_config`');
    await queryRunner.query('ALTER TABLE `endpoints` DROP COLUMN `name`');
  }
}
