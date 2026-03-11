import { Migration } from '@mikro-orm/migrations'

export class Migration20260311093000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            CREATE UNIQUE INDEX IF NOT EXISTS skald_memo_project_client_reference_unique
            ON skald_memo (project_id, client_reference_id)
            WHERE client_reference_id IS NOT NULL
        `)

        this.addSql(`
            CREATE UNIQUE INDEX IF NOT EXISTS skald_memo_project_source_url_unique
            ON skald_memo (project_id, source, (metadata->>'source_url'))
            WHERE source IS NOT NULL AND coalesce(metadata->>'source_url', '') <> ''
        `)
    }

    async down(): Promise<void> {
        this.addSql(`DROP INDEX IF EXISTS skald_memo_project_source_url_unique`)
        this.addSql(`DROP INDEX IF EXISTS skald_memo_project_client_reference_unique`)
    }
}
