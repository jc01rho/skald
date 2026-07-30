import { Migration } from '@mikro-orm/migrations'

export class Migration20260730134000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`set local lock_timeout = '2s';`)
        this.addSql(`set local statement_timeout = '15min';`)
        this.addSql(
            `do $$ begin
                if exists (
                    select 1
                    from skald_spec_source s
                    left join skald_spec_revision r
                      on r.project_id = s.project_id
                     and r.source_id = s.uuid
                     and r.uuid = s.active_revision_id
                    where s.active_revision_id is not null and r.uuid is null
                ) then
                    raise exception 'cannot validate active revision constraint: orphan active pointer exists';
                end if;
            end $$;`
        )
        this.addSql(
            `alter table "skald_spec_source" validate constraint "skald_spec_source_project_active_revision_foreign";`
        )
    }

    override async down(): Promise<void> {
        // Constraint validation is intentionally irreversible; the foreign key remains additive and valid.
    }
}
