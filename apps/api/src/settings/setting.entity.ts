import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Key/value runtime settings. Seeded with retention_days=10; edited directly in SQL (no admin UI). */
@Entity({ name: 'settings' })
export class Setting {
  @PrimaryColumn({ name: 'key', type: 'varchar', length: 64 })
  key: string;

  @Column({ name: 'value', type: 'varchar', length: 255 })
  value: string;
}
