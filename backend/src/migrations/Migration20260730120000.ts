import { Migration } from '@mikro-orm/migrations'

export class Migration20260730120000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(
            `alter table "skald_memo" add constraint "skald_memo_project_uuid_reference_key" unique ("project_id", "uuid", "client_reference_id");`
        )

        this.addSql(
            `create table "skald_spec_source" ("uuid" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "spec_id" varchar(512) not null, "source_system" varchar(100) not null, "source_type" varchar(100) not null, "immutable_source_id" varchar(512) not null, "source_locator" text not null, "memo_reference_id" varchar(512) not null, "memo_projection_revision_id" uuid not null, "memo_projection_canonical_hash" varchar(128) not null, "memo_id" uuid not null, "active_revision_id" uuid null, "project_id" uuid not null, constraint "skald_spec_source_pkey" primary key ("uuid"));`
        )
        this.addSql(
            `alter table "skald_spec_source" add constraint "skald_spec_source_project_uuid_key" unique ("project_id", "uuid");`
        )
        this.addSql(
            `alter table "skald_spec_source" add constraint "skald_spec_source_project_spec_id_key" unique ("project_id", "spec_id");`
        )
        this.addSql(
            `alter table "skald_spec_source" add constraint "skald_spec_source_project_identity_key" unique ("project_id", "source_system", "source_type", "immutable_source_id");`
        )
        this.addSql(`create index "skald_spec_source_project_id_idx" on "skald_spec_source" ("project_id");`)
        this.addSql(
            `create index "skald_spec_source_project_memo_idx" on "skald_spec_source" ("project_id", "memo_id");`
        )
        this.addSql(
            `create index "skald_spec_source_project_active_revision_idx" on "skald_spec_source" ("project_id", "active_revision_id");`
        )

        this.addSql(
            `create table "skald_spec_revision" ("uuid" uuid not null, "created_at" timestamptz not null, "revision_number" int not null, "idempotency_key" varchar(512) not null, "title" varchar(255) not null, "display_label" varchar(255) not null, "content" text not null, "metadata" jsonb not null default '{}', "payload_hash" varchar(128) not null, "content_hash" varchar(128) not null, "metadata_hash" varchar(128) not null, "relation_hash" varchar(128) not null, "claim_hash" varchar(128) not null, "relation_input_hash" varchar(128) not null, "canonical_hash" varchar(128) not null, "source_id" uuid not null, "project_id" uuid not null, constraint "skald_spec_revision_pkey" primary key ("uuid"), constraint "skald_spec_revision_number_check" check ("revision_number" > 0));`
        )
        this.addSql(
            `alter table "skald_spec_revision" add constraint "skald_spec_revision_project_uuid_key" unique ("project_id", "uuid");`
        )
        this.addSql(
            `alter table "skald_spec_revision" add constraint "skald_spec_revision_project_source_number_key" unique ("project_id", "source_id", "revision_number");`
        )
        this.addSql(
            `alter table "skald_spec_revision" add constraint "skald_spec_revision_project_source_idempotency_key" unique ("project_id", "source_id", "idempotency_key");`
        )
        this.addSql(
            `alter table "skald_spec_revision" add constraint "skald_spec_revision_project_source_uuid_key" unique ("project_id", "source_id", "uuid");`
        )
        this.addSql(`create index "skald_spec_revision_project_id_idx" on "skald_spec_revision" ("project_id");`)
        this.addSql(
            `create index "skald_spec_revision_project_source_created_idx" on "skald_spec_revision" ("project_id", "source_id", "created_at");`
        )
        this.addSql(
            `create index "skald_spec_revision_project_canonical_hash_idx" on "skald_spec_revision" ("project_id", "canonical_hash");`
        )

        this.addSql(
            `create table "skald_spec_relation" ("uuid" uuid not null, "created_at" timestamptz not null, "relation_id" varchar(512) not null, "kind" varchar(100) not null, "unresolved_target_spec_id" varchar(512) null, "source_relation_id" varchar(512) null, "display_label" varchar(255) null, "provenance" jsonb not null default '{}', "evidence" jsonb not null default '[]', "properties" jsonb not null default '{}', "source_id" uuid not null, "source_revision_id" uuid not null, "target_source_id" uuid null, "project_id" uuid not null, constraint "skald_spec_relation_pkey" primary key ("uuid"));`
        )
        this.addSql(
            `alter table "skald_spec_relation" add constraint "skald_spec_relation_project_uuid_key" unique ("project_id", "uuid");`
        )
        this.addSql(
            `alter table "skald_spec_relation" add constraint "skald_spec_relation_project_revision_relation_id_key" unique ("project_id", "source_revision_id", "relation_id");`
        )
        this.addSql(`create index "skald_spec_relation_project_id_idx" on "skald_spec_relation" ("project_id");`)
        this.addSql(
            `create index "skald_spec_relation_project_forward_idx" on "skald_spec_relation" ("project_id", "source_id", "source_revision_id", "kind", "target_source_id");`
        )
        this.addSql(
            `create index "skald_spec_relation_project_reverse_idx" on "skald_spec_relation" ("project_id", "target_source_id", "kind", "source_id", "source_revision_id");`
        )

        this.addSql(
            `create table "skald_spec_claim" ("uuid" uuid not null, "created_at" timestamptz not null, "claim_id" varchar(512) not null, "kind" varchar(100) not null, "text" text not null, "display_label" varchar(255) null, "subject" text null, "predicate" text null, "value" text null, "unit" varchar(100) null, "condition" text null, "object" text null, "evidence_excerpt" text null, "evidence_path" text null, "evidence_hash" varchar(128) null, "evidence" jsonb not null default '[]', "extractor_version" varchar(100) not null, "rule_version" varchar(100) not null, "source_id" uuid not null, "source_revision_id" uuid not null, "project_id" uuid not null, constraint "skald_spec_claim_pkey" primary key ("uuid"));`
        )
        this.addSql(
            `alter table "skald_spec_claim" add constraint "skald_spec_claim_project_uuid_key" unique ("project_id", "uuid");`
        )
        this.addSql(
            `alter table "skald_spec_claim" add constraint "skald_spec_claim_project_revision_claim_id_key" unique ("project_id", "source_revision_id", "claim_id");`
        )
        this.addSql(`create index "skald_spec_claim_project_id_idx" on "skald_spec_claim" ("project_id");`)
        this.addSql(
            `create index "skald_spec_claim_project_source_revision_idx" on "skald_spec_claim" ("project_id", "source_id", "source_revision_id", "kind");`
        )
        this.addSql(
            `create index "skald_spec_claim_project_normalized_idx" on "skald_spec_claim" ("project_id", "subject", "predicate");`
        )

        this.addSql(
            `alter table "skald_spec_source" add constraint "skald_spec_source_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_source" add constraint "skald_spec_source_project_memo_foreign" foreign key ("project_id", "memo_id", "memo_reference_id") references "skald_memo" ("project_id", "uuid", "client_reference_id") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_revision" add constraint "skald_spec_revision_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_revision" add constraint "skald_spec_revision_project_source_foreign" foreign key ("project_id", "source_id") references "skald_spec_source" ("project_id", "uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_relation" add constraint "skald_spec_relation_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_relation" add constraint "skald_spec_relation_project_source_foreign" foreign key ("project_id", "source_id") references "skald_spec_source" ("project_id", "uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_relation" add constraint "skald_spec_relation_project_revision_foreign" foreign key ("project_id", "source_id", "source_revision_id") references "skald_spec_revision" ("project_id", "source_id", "uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_relation" add constraint "skald_spec_relation_project_target_foreign" foreign key ("project_id", "target_source_id") references "skald_spec_source" ("project_id", "uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_claim" add constraint "skald_spec_claim_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_claim" add constraint "skald_spec_claim_project_source_foreign" foreign key ("project_id", "source_id") references "skald_spec_source" ("project_id", "uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_claim" add constraint "skald_spec_claim_project_revision_foreign" foreign key ("project_id", "source_id", "source_revision_id") references "skald_spec_revision" ("project_id", "source_id", "uuid") on update cascade deferrable initially deferred;`
        )

        this.addSql(
            `alter table "skald_spec_source" add constraint "skald_spec_source_project_active_revision_foreign" foreign key ("project_id", "uuid", "active_revision_id") references "skald_spec_revision" ("project_id", "source_id", "uuid") on update cascade deferrable initially deferred not valid;`
        )
    }

    override async down(): Promise<void> {
        this.addSql(`alter table "skald_spec_source" drop constraint "skald_spec_source_project_active_revision_foreign";`)
        this.addSql(`drop table if exists "skald_spec_claim" cascade;`)
        this.addSql(`drop table if exists "skald_spec_relation" cascade;`)
        this.addSql(`drop table if exists "skald_spec_revision" cascade;`)
        this.addSql(`drop table if exists "skald_spec_source" cascade;`)
        this.addSql(`alter table "skald_memo" drop constraint "skald_memo_project_uuid_reference_key";`)
    }
}
