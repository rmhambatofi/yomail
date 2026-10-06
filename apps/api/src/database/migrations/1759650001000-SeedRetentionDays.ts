import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SeedRetentionDays1759650001000 implements MigrationInterface {
  name = 'SeedRetentionDays1759650001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "INSERT INTO `settings` (`key`, `value`) VALUES ('retention_days', '10') ON DUPLICATE KEY UPDATE `key` = `key`",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM `settings` WHERE `key` = 'retention_days'");
  }
}
