import { Migration } from '@mikro-orm/migrations'

export class Migration20260730131000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(
            `create table "skald_spec_traversal_snapshot" ("uuid" uuid not null, "created_at" timestamptz not null, "expires_at" timestamptz not null, "filter_hash" varchar(64) not null, "root_locator" varchar(1024) not null, "max_depth" int not null, "max_nodes" int not null, "traversal_depth" int not null, "traversal_complete" boolean not null, "truncated_reason" varchar(100) null, "item_count" int not null, "project_id" uuid not null, constraint "skald_spec_traversal_snapshot_pkey" primary key ("uuid"), constraint "skald_spec_traversal_snapshot_bounds_check" check ("max_depth" between 1 and 5 and "max_nodes" between 1 and 500 and "item_count" >= 0), constraint "skald_spec_traversal_snapshot_expiry_check" check ("expires_at" > "created_at"));`
        )
        this.addSql(
            `alter table "skald_spec_traversal_snapshot" add constraint "skald_spec_traversal_snapshot_project_uuid_key" unique ("project_id", "uuid");`
        )
        this.addSql(`create index "skald_spec_traversal_snapshot_project_id_idx" on "skald_spec_traversal_snapshot" ("project_id");`)
        this.addSql(
            `create index "skald_spec_traversal_snapshot_project_expires_idx" on "skald_spec_traversal_snapshot" ("project_id", "expires_at");`
        )

        this.addSql(
            `create table "skald_spec_traversal_snapshot_item" ("uuid" uuid not null, "ordinal" int not null, "item_type" varchar(20) not null, "payload" jsonb not null, "snapshot_id" uuid not null, "project_id" uuid not null, constraint "skald_spec_traversal_snapshot_item_pkey" primary key ("uuid"), constraint "skald_spec_traversal_snapshot_item_type_check" check ("item_type" in ('node', 'edge')), constraint "skald_spec_traversal_snapshot_item_ordinal_check" check ("ordinal" >= 0));`
        )
        this.addSql(
            `alter table "skald_spec_traversal_snapshot_item" add constraint "skald_spec_traversal_snapshot_item_project_snapshot_ordinal_key" unique ("project_id", "snapshot_id", "ordinal");`
        )
        this.addSql(`create index "skald_spec_traversal_snapshot_item_project_id_idx" on "skald_spec_traversal_snapshot_item" ("project_id");`)

        this.addSql(
            `alter table "skald_spec_traversal_snapshot" add constraint "skald_spec_traversal_snapshot_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_traversal_snapshot_item" add constraint "skald_spec_traversal_snapshot_item_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_traversal_snapshot_item" add constraint "skald_spec_traversal_snapshot_item_snapshot_foreign" foreign key ("project_id", "snapshot_id") references "skald_spec_traversal_snapshot" ("project_id", "uuid") on update cascade on delete cascade deferrable initially deferred;`
        )
    }

    override async down(): Promise<void> {
        this.addSql(`drop table if exists "skald_spec_traversal_snapshot_item" cascade;`)
        this.addSql(`drop table if exists "skald_spec_traversal_snapshot" cascade;`)
    }
}
