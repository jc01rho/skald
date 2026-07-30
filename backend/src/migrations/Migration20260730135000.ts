import { Migration } from '@mikro-orm/migrations'

export class Migration20260730135000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`alter table "skald_spec_promotion_state" add column "quality_readiness" jsonb null;`)
    }

    override async down(): Promise<void> {
        this.addSql(`alter table "skald_spec_promotion_state" drop column "quality_readiness";`)
    }
}
