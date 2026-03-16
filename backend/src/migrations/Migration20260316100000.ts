import { Migration } from '@mikro-orm/migrations'

export class Migration20260316100000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            CREATE TABLE skald_memo_submission (
                uuid UUID PRIMARY KEY,
                created_at TIMESTAMP NOT NULL,
                updated_at TIMESTAMP NOT NULL,
                title VARCHAR(255) NOT NULL,
                content TEXT NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                reviewed_at TIMESTAMP,
                rejection_reason TEXT,
                project_id UUID NOT NULL REFERENCES skald_project(uuid) ON DELETE CASCADE,
                reviewed_by BIGINT REFERENCES skald_user(id) ON DELETE SET NULL
            )
        `)

        this.addSql(`
            CREATE INDEX skald_memo_submission_project_status_idx
            ON skald_memo_submission (project_id, status)
        `)

        this.addSql(`
            CREATE INDEX skald_memo_submission_created_at_idx
            ON skald_memo_submission (created_at)
        `)

        this.addSql(`
            CREATE INDEX skald_memo_submission_project_id_idx
            ON skald_memo_submission (project_id)
        `)

        this.addSql(`
            CREATE INDEX skald_memo_submission_reviewed_by_idx
            ON skald_memo_submission (reviewed_by)
        `)
    }

    async down(): Promise<void> {
        this.addSql(`DROP INDEX IF EXISTS skald_memo_submission_reviewed_by_idx`)
        this.addSql(`DROP INDEX IF EXISTS skald_memo_submission_project_id_idx`)
        this.addSql(`DROP INDEX IF EXISTS skald_memo_submission_created_at_idx`)
        this.addSql(`DROP INDEX IF EXISTS skald_memo_submission_project_status_idx`)
        this.addSql(`DROP TABLE IF EXISTS skald_memo_submission`)
    }
}
