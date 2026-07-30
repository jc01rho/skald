import { Migration } from '@mikro-orm/migrations'

export class Migration20260730136000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`create table "skald_spec_quality_query_manifest" (
            "uuid" uuid not null,
            "project_id" uuid not null,
            "scope_key" varchar(512) not null,
            "reconciliation_run_id" varchar(512) not null,
            "dataset" varchar(512) not null,
            "dataset_version" varchar(512) not null,
            "query_manifest_sha256" char(64) not null,
            "content" text not null,
            "registered_by" varchar(512) not null,
            "created_at" timestamptz not null,
            constraint "skald_spec_quality_query_manifest_pkey" primary key ("uuid"),
            constraint "skald_spec_quality_query_manifest_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade on delete cascade deferrable initially deferred,
            constraint "skald_spec_quality_query_manifest_binding_unique" unique ("project_id", "scope_key", "reconciliation_run_id", "dataset", "dataset_version")
        );`)
        this.addSql(`create index "skald_spec_quality_query_manifest_digest_idx" on "skald_spec_quality_query_manifest" ("project_id", "query_manifest_sha256");`)
        this.addSql(`alter table "skald_spec_quality_query_manifest" add constraint "skald_spec_quality_query_manifest_run_foreign" foreign key ("project_id", "scope_key", "reconciliation_run_id") references "skald_spec_reconciliation_run" ("project_id", "scope_key", "run_id") on update cascade deferrable initially deferred;`)
    }

    override async down(): Promise<void> {
        this.addSql(`drop table if exists "skald_spec_quality_query_manifest" cascade;`)
    }
}
