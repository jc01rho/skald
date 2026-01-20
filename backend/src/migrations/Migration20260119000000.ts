import { Migration } from '@mikro-orm/migrations'

/**
 * Add memo_uuid and project_uuid columns to skald_memochunk table.
 * These columns store the UUID values for denormalized access,
 * complementing the existing memo_id and project_id foreign keys.
 */
export class Migration20260119000000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "skald_memochunk"
            ADD COLUMN "memo_uuid" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
        `)

        this.addSql(`
            ALTER TABLE "skald_memochunk"
            ADD COLUMN "project_uuid" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
        `)

        this.addSql(`
            UPDATE "skald_memochunk" mc
            SET "memo_uuid" = m."uuid"
            FROM "skald_memo" m
            WHERE mc."memo_id" = m."uuid";
        `)

        this.addSql(`
            UPDATE "skald_memochunk" mc
            SET "project_uuid" = p."uuid"
            FROM "skald_project" p
            WHERE mc."project_id" = p."uuid";
        `)

        this.addSql(`
            ALTER TABLE "skald_memochunk"
            ALTER COLUMN "memo_uuid" DROP DEFAULT;
        `)
        this.addSql(`
            ALTER TABLE "skald_memochunk"
            ALTER COLUMN "project_uuid" DROP DEFAULT;
        `)
    }

    override async down(): Promise<void> {
        this.addSql(`ALTER TABLE "skald_memochunk" DROP COLUMN IF EXISTS "memo_uuid";`)
        this.addSql(`ALTER TABLE "skald_memochunk" DROP COLUMN IF EXISTS "project_uuid";`)
    }
}
