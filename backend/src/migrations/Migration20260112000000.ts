import { Migration } from '@mikro-orm/migrations'

export class Migration20260112000000 extends Migration {
    override async up(): Promise<void> {
        // First, delete all existing embeddings (dimension mismatch makes conversion impossible)
        this.addSql(`DELETE FROM "skald_memochunk";`)
        this.addSql(`DELETE FROM "skald_memosummary";`)

        // Then, alter the column type from vector(2048) to vector(1792)
        this.addSql(`ALTER TABLE "skald_memochunk" ALTER COLUMN "embedding" TYPE vector(1792);`)
        this.addSql(`ALTER TABLE "skald_memosummary" ALTER COLUMN "embedding" TYPE vector(1792);`)
    }

    override async down(): Promise<void> {
        // Revert to vector(2048) - note: this will also lose data
        this.addSql(`DELETE FROM "skald_memochunk";`)
        this.addSql(`DELETE FROM "skald_memosummary";`)

        this.addSql(`ALTER TABLE "skald_memochunk" ALTER COLUMN "embedding" TYPE vector(2048);`)
        this.addSql(`ALTER TABLE "skald_memosummary" ALTER COLUMN "embedding" TYPE vector(2048);`)
    }
}
