import { Migration } from '@mikro-orm/migrations'

export class Migration20260408170000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(
            `create table "skald_project_sweep_state" ("uuid" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "sweep_type" varchar(100) not null, "next_offset" int not null default 0, "metadata" jsonb null, "project_id" uuid not null, constraint "skald_project_sweep_state_pkey" primary key ("uuid"));`
        )
        this.addSql(
            `create index "skald_project_sweep_state_project_id_idx" on "skald_project_sweep_state" ("project_id");`
        )
        this.addSql(
            `create index "skald_project_sweep_state_project_idx" on "skald_project_sweep_state" ("project_id");`
        )
        this.addSql(
            `alter table "skald_project_sweep_state" add constraint "skald_project_sweep_state_project_type_key" unique ("project_id", "sweep_type");`
        )
        this.addSql(
            `alter table "skald_project_sweep_state" add constraint "skald_project_sweep_state_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )
    }
}
