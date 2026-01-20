import { Migration } from '@mikro-orm/migrations'

export class Migration20260119100000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`DELETE FROM "skald_memochunk";`)
        this.addSql(`DELETE FROM "skald_memosummary";`)

        this.addSql(`ALTER TABLE "skald_memochunk" ALTER COLUMN "embedding" TYPE vector(2048);`)
        this.addSql(`ALTER TABLE "skald_memosummary" ALTER COLUMN "embedding" TYPE vector(2048);`)
    }

    override async down(): Promise<void> {
        this.addSql(`DELETE FROM "skald_memochunk";`)
        this.addSql(`DELETE FROM "skald_memosummary";`)

        this.addSql(`ALTER TABLE "skald_memochunk" ALTER COLUMN "embedding" TYPE vector(1792);`)
        this.addSql(`ALTER TABLE "skald_memosummary" ALTER COLUMN "embedding" TYPE vector(1792);`)
    }
}
