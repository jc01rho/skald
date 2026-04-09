import { Migration } from '@mikro-orm/migrations'

export class Migration20260407143000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(
            `alter table "skald_wiki_page" add column "page_type" varchar(50) not null default 'source_digest_page';`
        )
        this.addSql(`alter table "skald_wiki_page" add column "canonical" varchar(255) null;`)
        this.addSql(`alter table "skald_wiki_page" add column "confidence" real not null default 0.5;`)
        this.addSql(`alter table "skald_wiki_page" add column "freshness" real not null default 0.5;`)
        this.addSql(`alter table "skald_wiki_page" add column "review_status" varchar(50) not null default 'draft';`)
        this.addSql(`alter table "skald_wiki_page" add column "source_coverage_score" real not null default 0;`)
        this.addSql(`alter table "skald_wiki_page" add column "management_mode" varchar(50) not null default 'manual';`)

        this.addSql(`alter table "skald_wiki_page_revision" add column "page_type" varchar(50) null;`)
        this.addSql(`alter table "skald_wiki_page_revision" add column "canonical" varchar(255) null;`)
        this.addSql(`alter table "skald_wiki_page_revision" add column "confidence" real null;`)
        this.addSql(`alter table "skald_wiki_page_revision" add column "freshness" real null;`)
        this.addSql(`alter table "skald_wiki_page_revision" add column "review_status" varchar(50) null;`)
        this.addSql(`alter table "skald_wiki_page_revision" add column "source_coverage_score" real null;`)
        this.addSql(`alter table "skald_wiki_page_revision" add column "management_mode" varchar(50) null;`)

        this.addSql(
            `create table "skald_raw_source_document" ("uuid" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "source_type" varchar(100) not null, "external_reference" varchar(255) null, "title" text not null, "description" text null, "metadata" jsonb null, "project_id" uuid not null, constraint "skald_raw_source_document_pkey" primary key ("uuid"));`
        )
        this.addSql(
            `create index "skald_raw_source_document_project_id_idx" on "skald_raw_source_document" ("project_id");`
        )
        this.addSql(
            `create index "skald_raw_source_document_project_source_idx" on "skald_raw_source_document" ("project_id", "source_type");`
        )
        this.addSql(
            `create index "skald_raw_source_document_project_ref_idx" on "skald_raw_source_document" ("project_id", "external_reference");`
        )
        this.addSql(
            `alter table "skald_raw_source_document" add constraint "skald_raw_source_document_project_source_reference_key" unique ("project_id", "source_type", "external_reference");`
        )
        this.addSql(
            `alter table "skald_raw_source_document" add constraint "skald_raw_source_document_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )

        this.addSql(
            `create table "skald_raw_source_content" ("uuid" uuid not null, "created_at" timestamptz not null, "content" text not null, "content_hash" varchar(255) null, "content_length" int null, "extraction_metadata" jsonb null, "raw_source_document_id" uuid not null, "project_id" uuid not null, constraint "skald_raw_source_content_pkey" primary key ("uuid"));`
        )
        this.addSql(
            `create index "skald_raw_source_content_document_id_idx" on "skald_raw_source_content" ("raw_source_document_id");`
        )
        this.addSql(
            `create index "skald_raw_source_content_project_id_idx" on "skald_raw_source_content" ("project_id");`
        )
        this.addSql(
            `create index "skald_raw_source_content_document_idx" on "skald_raw_source_content" ("raw_source_document_id", "created_at");`
        )
        this.addSql(
            `alter table "skald_raw_source_content" add constraint "skald_raw_source_content_document_hash_key" unique ("raw_source_document_id", "content_hash");`
        )
        this.addSql(
            `alter table "skald_raw_source_content" add constraint "skald_raw_source_content_document_id_foreign" foreign key ("raw_source_document_id") references "skald_raw_source_document" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_raw_source_content" add constraint "skald_raw_source_content_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )

        this.addSql(
            `create table "skald_wiki_rule" ("uuid" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "rule_type" varchar(100) not null, "name" varchar(255) not null, "description" text not null, "config" jsonb not null, "priority" int not null default 100, "is_active" boolean not null default true, "project_id" uuid not null, "created_by_id" bigint null, constraint "skald_wiki_rule_pkey" primary key ("uuid"));`
        )
        this.addSql(`create index "skald_wiki_rule_project_id_idx" on "skald_wiki_rule" ("project_id");`)
        this.addSql(`create index "skald_wiki_rule_created_by_id_idx" on "skald_wiki_rule" ("created_by_id");`)
        this.addSql(`create index "skald_wiki_rule_project_type_idx" on "skald_wiki_rule" ("project_id", "rule_type");`)
        this.addSql(
            `create index "skald_wiki_rule_project_active_idx" on "skald_wiki_rule" ("project_id", "is_active");`
        )
        this.addSql(
            `alter table "skald_wiki_rule" add constraint "skald_wiki_rule_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_rule" add constraint "skald_wiki_rule_created_by_id_foreign" foreign key ("created_by_id") references "skald_user" ("id") on update cascade on delete set null deferrable initially deferred;`
        )

        this.addSql(
            `create table "skald_wiki_refresh_request" ("uuid" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz null, "trigger" varchar(50) not null, "status" varchar(50) not null default 'pending', "error_message" text null, "process_started_at" timestamptz null, "process_completed_at" timestamptz null, "metadata" jsonb null, "raw_source_document_id" uuid null, "project_id" uuid not null, constraint "skald_wiki_refresh_request_pkey" primary key ("uuid"));`
        )
        this.addSql(
            `create index "skald_wiki_refresh_request_document_id_idx" on "skald_wiki_refresh_request" ("raw_source_document_id");`
        )
        this.addSql(
            `create index "skald_wiki_refresh_request_project_id_idx" on "skald_wiki_refresh_request" ("project_id");`
        )
        this.addSql(
            `create index "skald_wiki_refresh_request_project_status_idx" on "skald_wiki_refresh_request" ("project_id", "status");`
        )
        this.addSql(
            `create index "skald_wiki_refresh_request_source_idx" on "skald_wiki_refresh_request" ("raw_source_document_id", "status");`
        )
        this.addSql(
            `create index "skald_wiki_refresh_request_created_idx" on "skald_wiki_refresh_request" ("created_at");`
        )
        this.addSql(
            `alter table "skald_wiki_refresh_request" add constraint "skald_wiki_refresh_request_document_id_foreign" foreign key ("raw_source_document_id") references "skald_raw_source_document" ("uuid") on update cascade on delete set null deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_refresh_request" add constraint "skald_wiki_refresh_request_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )

        this.addSql(
            `create table "skald_wiki_page_source_link" ("uuid" uuid not null, "created_at" timestamptz not null, "contribution_metadata" jsonb null, "wiki_page_revision_id" uuid not null, "raw_source_document_id" uuid not null, "project_id" uuid not null, constraint "skald_wiki_page_source_link_pkey" primary key ("uuid"));`
        )
        this.addSql(
            `create index "skald_wiki_page_source_link_revision_id_idx" on "skald_wiki_page_source_link" ("wiki_page_revision_id");`
        )
        this.addSql(
            `create index "skald_wiki_page_source_link_document_id_idx" on "skald_wiki_page_source_link" ("raw_source_document_id");`
        )
        this.addSql(
            `create index "skald_wiki_page_source_link_project_id_idx" on "skald_wiki_page_source_link" ("project_id");`
        )
        this.addSql(
            `create index "skald_wiki_page_source_link_revision_idx" on "skald_wiki_page_source_link" ("wiki_page_revision_id");`
        )
        this.addSql(
            `create index "skald_wiki_page_source_link_source_idx" on "skald_wiki_page_source_link" ("raw_source_document_id");`
        )
        this.addSql(
            `alter table "skald_wiki_page_source_link" add constraint "skald_wiki_page_source_link_unique_key" unique ("wiki_page_revision_id", "raw_source_document_id");`
        )
        this.addSql(
            `alter table "skald_wiki_page_source_link" add constraint "skald_wiki_page_source_link_revision_id_foreign" foreign key ("wiki_page_revision_id") references "skald_wiki_page_revision" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_page_source_link" add constraint "skald_wiki_page_source_link_document_id_foreign" foreign key ("raw_source_document_id") references "skald_raw_source_document" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_page_source_link" add constraint "skald_wiki_page_source_link_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )

        this.addSql(
            `create table "skald_wiki_node" ("uuid" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "node_type" varchar(50) not null, "canonical_name" varchar(255) not null, "display_name" varchar(255) not null, "description" text null, "metadata" jsonb not null default '{}', "confidence" real not null default 0.5, "freshness" real not null default 0.5, "project_id" uuid not null, constraint "skald_wiki_node_pkey" primary key ("uuid"));`
        )
        this.addSql(`create index "skald_wiki_node_project_id_idx" on "skald_wiki_node" ("project_id");`)
        this.addSql(`create index "skald_wiki_node_project_type_idx" on "skald_wiki_node" ("project_id", "node_type");`)
        this.addSql(
            `alter table "skald_wiki_node" add constraint "skald_wiki_node_project_type_canonical_key" unique ("project_id", "node_type", "canonical_name");`
        )
        this.addSql(
            `alter table "skald_wiki_node" add constraint "skald_wiki_node_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )

        this.addSql(
            `create table "skald_wiki_edge" ("uuid" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "edge_type" varchar(50) not null, "weight" int not null default 1, "provenance_type" varchar(50) null, "from_node_id" uuid not null, "to_node_id" uuid not null, "project_id" uuid not null, constraint "skald_wiki_edge_pkey" primary key ("uuid"));`
        )
        this.addSql(`create index "skald_wiki_edge_from_node_id_idx" on "skald_wiki_edge" ("from_node_id");`)
        this.addSql(`create index "skald_wiki_edge_to_node_id_idx" on "skald_wiki_edge" ("to_node_id");`)
        this.addSql(`create index "skald_wiki_edge_project_id_idx" on "skald_wiki_edge" ("project_id");`)
        this.addSql(`create index "skald_wiki_edge_project_type_idx" on "skald_wiki_edge" ("project_id", "edge_type");`)
        this.addSql(`create index "skald_wiki_edge_from_to_idx" on "skald_wiki_edge" ("from_node_id", "to_node_id");`)
        this.addSql(
            `alter table "skald_wiki_edge" add constraint "skald_wiki_edge_project_from_to_type_key" unique ("project_id", "from_node_id", "to_node_id", "edge_type");`
        )
        this.addSql(
            `alter table "skald_wiki_edge" add constraint "skald_wiki_edge_from_node_id_foreign" foreign key ("from_node_id") references "skald_wiki_node" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_edge" add constraint "skald_wiki_edge_to_node_id_foreign" foreign key ("to_node_id") references "skald_wiki_node" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_edge" add constraint "skald_wiki_edge_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )

        this.addSql(
            `create table "skald_wiki_claim" ("uuid" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "claim_text" text not null, "claim_type" varchar(50) not null, "confidence" real not null default 0.5, "freshness" real not null default 0.5, "contradiction_status" varchar(50) not null default 'compatible', "page_id" uuid not null, "node_id" uuid null, "project_id" uuid not null, constraint "skald_wiki_claim_pkey" primary key ("uuid"));`
        )
        this.addSql(`create index "skald_wiki_claim_page_id_idx" on "skald_wiki_claim" ("page_id");`)
        this.addSql(`create index "skald_wiki_claim_node_id_idx" on "skald_wiki_claim" ("node_id");`)
        this.addSql(`create index "skald_wiki_claim_project_id_idx" on "skald_wiki_claim" ("project_id");`)
        this.addSql(
            `create index "skald_wiki_claim_project_type_idx" on "skald_wiki_claim" ("project_id", "claim_type");`
        )
        this.addSql(`create index "skald_wiki_claim_page_idx" on "skald_wiki_claim" ("page_id");`)
        this.addSql(
            `alter table "skald_wiki_claim" add constraint "skald_wiki_claim_page_id_foreign" foreign key ("page_id") references "skald_wiki_page" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_claim" add constraint "skald_wiki_claim_node_id_foreign" foreign key ("node_id") references "skald_wiki_node" ("uuid") on update cascade on delete set null deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_claim" add constraint "skald_wiki_claim_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )

        this.addSql(
            `create table "skald_wiki_source_ref" ("uuid" uuid not null, "created_at" timestamptz not null, "source_kind" varchar(50) not null, "locator_text" text null, "excerpt" text null, "memo_id" uuid null, "memo_chunk_id" uuid null, "memo_summary_id" uuid null, "raw_source_document_id" uuid null, "project_id" uuid not null, constraint "skald_wiki_source_ref_pkey" primary key ("uuid"));`
        )
        this.addSql(`create index "skald_wiki_source_ref_memo_id_idx" on "skald_wiki_source_ref" ("memo_id");`)
        this.addSql(`create index "skald_wiki_source_ref_chunk_id_idx" on "skald_wiki_source_ref" ("memo_chunk_id");`)
        this.addSql(
            `create index "skald_wiki_source_ref_summary_id_idx" on "skald_wiki_source_ref" ("memo_summary_id");`
        )
        this.addSql(
            `create index "skald_wiki_source_ref_raw_source_document_id_idx" on "skald_wiki_source_ref" ("raw_source_document_id");`
        )
        this.addSql(`create index "skald_wiki_source_ref_project_id_idx" on "skald_wiki_source_ref" ("project_id");`)
        this.addSql(
            `create index "skald_wiki_source_ref_project_kind_idx" on "skald_wiki_source_ref" ("project_id", "source_kind");`
        )
        this.addSql(
            `alter table "skald_wiki_source_ref" add constraint "skald_wiki_source_ref_memo_id_foreign" foreign key ("memo_id") references "skald_memo" ("uuid") on update cascade on delete set null deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_source_ref" add constraint "skald_wiki_source_ref_chunk_id_foreign" foreign key ("memo_chunk_id") references "skald_memochunk" ("uuid") on update cascade on delete set null deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_source_ref" add constraint "skald_wiki_source_ref_summary_id_foreign" foreign key ("memo_summary_id") references "skald_memosummary" ("uuid") on update cascade on delete set null deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_source_ref" add constraint "skald_wiki_source_ref_raw_source_document_id_foreign" foreign key ("raw_source_document_id") references "skald_raw_source_document" ("uuid") on update cascade on delete set null deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_source_ref" add constraint "skald_wiki_source_ref_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )

        this.addSql(
            `create table "skald_wiki_claim_source_ref" ("uuid" uuid not null, "support_type" varchar(50) not null, "confidence" real not null default 0.5, "excerpt" text null, "claim_id" uuid not null, "source_ref_id" uuid not null, constraint "skald_wiki_claim_source_ref_pkey" primary key ("uuid"));`
        )
        this.addSql(
            `create index "skald_wiki_claim_source_ref_claim_id_idx" on "skald_wiki_claim_source_ref" ("claim_id");`
        )
        this.addSql(
            `create index "skald_wiki_claim_source_ref_source_ref_id_idx" on "skald_wiki_claim_source_ref" ("source_ref_id");`
        )
        this.addSql(
            `create index "skald_wiki_claim_source_ref_claim_idx" on "skald_wiki_claim_source_ref" ("claim_id");`
        )
        this.addSql(
            `alter table "skald_wiki_claim_source_ref" add constraint "skald_wiki_claim_source_ref_claim_id_foreign" foreign key ("claim_id") references "skald_wiki_claim" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_claim_source_ref" add constraint "skald_wiki_claim_source_ref_source_ref_id_foreign" foreign key ("source_ref_id") references "skald_wiki_source_ref" ("uuid") on update cascade deferrable initially deferred;`
        )

        this.addSql(
            `create table "skald_wiki_page_link" ("uuid" uuid not null, "link_type" varchar(50) not null, "anchor_text" text null, "from_page_id" uuid not null, "to_page_id" uuid not null, constraint "skald_wiki_page_link_pkey" primary key ("uuid"));`
        )
        this.addSql(`create index "skald_wiki_page_link_from_page_id_idx" on "skald_wiki_page_link" ("from_page_id");`)
        this.addSql(`create index "skald_wiki_page_link_to_page_id_idx" on "skald_wiki_page_link" ("to_page_id");`)
        this.addSql(
            `create index "skald_wiki_page_link_from_to_idx" on "skald_wiki_page_link" ("from_page_id", "to_page_id");`
        )
        this.addSql(
            `alter table "skald_wiki_page_link" add constraint "skald_wiki_page_link_from_to_type_key" unique ("from_page_id", "to_page_id", "link_type");`
        )
        this.addSql(
            `alter table "skald_wiki_page_link" add constraint "skald_wiki_page_link_from_page_id_foreign" foreign key ("from_page_id") references "skald_wiki_page" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_wiki_page_link" add constraint "skald_wiki_page_link_to_page_id_foreign" foreign key ("to_page_id") references "skald_wiki_page" ("uuid") on update cascade deferrable initially deferred;`
        )

        this.addSql(
            `create table "skald_wiki_compile_run" ("uuid" uuid not null, "started_at" timestamptz not null, "completed_at" timestamptz null, "trigger_type" varchar(50) not null, "status" varchar(50) not null default 'pending', "memos_considered" int not null default 0, "pages_created" int not null default 0, "pages_updated" int not null default 0, "claims_created" int not null default 0, "edges_created" int not null default 0, "conflicts_found" int not null default 0, "notes" jsonb null, "project_id" uuid not null, constraint "skald_wiki_compile_run_pkey" primary key ("uuid"));`
        )
        this.addSql(`create index "skald_wiki_compile_run_project_id_idx" on "skald_wiki_compile_run" ("project_id");`)
        this.addSql(
            `create index "skald_wiki_compile_run_project_status_idx" on "skald_wiki_compile_run" ("project_id", "status");`
        )
        this.addSql(
            `alter table "skald_wiki_compile_run" add constraint "skald_wiki_compile_run_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )
    }

    override async down(): Promise<void> {
        this.addSql(`drop table if exists "skald_wiki_compile_run" cascade;`)
        this.addSql(`drop table if exists "skald_wiki_page_link" cascade;`)
        this.addSql(`drop table if exists "skald_wiki_claim_source_ref" cascade;`)
        this.addSql(`drop table if exists "skald_wiki_source_ref" cascade;`)
        this.addSql(`drop table if exists "skald_wiki_claim" cascade;`)
        this.addSql(`drop table if exists "skald_wiki_edge" cascade;`)
        this.addSql(`drop table if exists "skald_wiki_node" cascade;`)
        this.addSql(`drop table if exists "skald_wiki_page_source_link" cascade;`)
        this.addSql(`drop table if exists "skald_wiki_refresh_request" cascade;`)
        this.addSql(`drop table if exists "skald_wiki_rule" cascade;`)
        this.addSql(`drop table if exists "skald_raw_source_content" cascade;`)
        this.addSql(`drop table if exists "skald_raw_source_document" cascade;`)
        this.addSql(`alter table "skald_wiki_page_revision" drop column if exists "management_mode";`)
        this.addSql(`alter table "skald_wiki_page_revision" drop column if exists "source_coverage_score";`)
        this.addSql(`alter table "skald_wiki_page_revision" drop column if exists "review_status";`)
        this.addSql(`alter table "skald_wiki_page_revision" drop column if exists "freshness";`)
        this.addSql(`alter table "skald_wiki_page_revision" drop column if exists "confidence";`)
        this.addSql(`alter table "skald_wiki_page_revision" drop column if exists "canonical";`)
        this.addSql(`alter table "skald_wiki_page_revision" drop column if exists "page_type";`)
        this.addSql(`alter table "skald_wiki_page" drop column if exists "management_mode";`)
        this.addSql(`alter table "skald_wiki_page" drop column if exists "source_coverage_score";`)
        this.addSql(`alter table "skald_wiki_page" drop column if exists "review_status";`)
        this.addSql(`alter table "skald_wiki_page" drop column if exists "freshness";`)
        this.addSql(`alter table "skald_wiki_page" drop column if exists "confidence";`)
        this.addSql(`alter table "skald_wiki_page" drop column if exists "canonical";`)
        this.addSql(`alter table "skald_wiki_page" drop column if exists "page_type";`)
    }
}
