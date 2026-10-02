import { Migration } from '@mikro-orm/migrations'

export class Migration20261002120000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`create table "skald_spec_annotation" (
            "uuid" uuid not null,
            "created_at" timestamptz not null,
            "updated_at" timestamptz not null,
            "kind" varchar(50) not null,
            "status" varchar(30) not null,
            "body" text not null,
            "condition" text null,
            "effect" text null,
            "applies_to" text null,
            "anchor_revision_id" uuid null,
            "anchor_content_hash" varchar(128) null,
            "created_by" varchar(254) null,
            "updated_by" varchar(254) null,
            "version" int not null default 1,
            "source_id" uuid not null,
            "project_id" uuid not null,
            constraint "skald_spec_annotation_pkey" primary key ("uuid"),
            constraint "skald_spec_annotation_kind_check" check ("kind" in ('ADDITIONAL_NOTE', 'AUTOMATION_HINT')),
            constraint "skald_spec_annotation_status_check" check ("status" in ('ACTIVE', 'NEEDS_REVIEW', 'ARCHIVED'))
        );`)
        this.addSql(`create index "skald_spec_annotation_project_id_idx" on "skald_spec_annotation" ("project_id");`)
        this.addSql(`create index "skald_spec_annotation_project_source_status_idx" on "skald_spec_annotation" ("project_id", "source_id", "status");`)
        this.addSql(`alter table "skald_spec_annotation" add constraint "skald_spec_annotation_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade on delete cascade deferrable initially deferred;`)
        this.addSql(`alter table "skald_spec_annotation" add constraint "skald_spec_annotation_project_source_foreign" foreign key ("project_id", "source_id") references "skald_spec_source" ("project_id", "uuid") on update cascade deferrable initially deferred;`)
    }

    override async down(): Promise<void> {
        this.addSql(`drop table if exists "skald_spec_annotation" cascade;`)
    }
}
