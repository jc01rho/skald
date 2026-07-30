import { Migration } from '@mikro-orm/migrations'

export class Migration20260730130000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(
            `create table "skald_spec_reconciliation_run" ("uuid" uuid not null, "run_id" varchar(512) not null, "scope_key" varchar(512) not null, "source_system" varchar(100) null, "source_type" varchar(100) null, "authoritative" boolean not null default false, "complete" boolean not null default false, "manifest_hash" varchar(128) null, "identity_drift" int not null default 0, "revision_drift" int not null default 0, "authorization_drift" int not null default 0, "relation_drift" int not null default 0, "claim_drift" int not null default 0, "memo_link_drift" int not null default 0, "started_at" timestamptz not null, "completed_at" timestamptz null, "project_id" uuid not null, constraint "skald_spec_reconciliation_run_pkey" primary key ("uuid"), constraint "skald_spec_reconciliation_run_drift_check" check ("identity_drift" >= 0 and "revision_drift" >= 0 and "authorization_drift" >= 0 and "relation_drift" >= 0 and "claim_drift" >= 0 and "memo_link_drift" >= 0), constraint "skald_spec_reconciliation_run_completion_check" check ((not "complete" and "completed_at" is null and "manifest_hash" is null) or ("complete" and "completed_at" is not null and "manifest_hash" is not null and "completed_at" >= "started_at")));`
        )
        this.addSql(
            `alter table "skald_spec_reconciliation_run" add constraint "skald_spec_reconciliation_run_project_uuid_key" unique ("project_id", "uuid");`
        )
        this.addSql(
            `alter table "skald_spec_reconciliation_run" add constraint "skald_spec_reconciliation_run_project_scope_run_id_key" unique ("project_id", "scope_key", "run_id");`
        )
        this.addSql(`create index "skald_spec_reconciliation_run_project_id_idx" on "skald_spec_reconciliation_run" ("project_id");`)
        this.addSql(
            `create index "skald_spec_reconciliation_run_project_scope_completed_idx" on "skald_spec_reconciliation_run" ("project_id", "scope_key", "completed_at");`
        )

        this.addSql(
            `create table "skald_spec_promotion_state" ("uuid" uuid not null, "scope_key" varchar(512) not null, "consecutive_clean_runs" int not null default 0, "last_clean_run_id" varchar(512) null, "previous_clean_run_id" varchar(512) null, "last_clean_completed_at" timestamptz null, "state" text check ("state" in ('shadow', 'canary_eligible', 'promoted')) not null default 'shadow', "promoted_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "project_id" uuid not null, constraint "skald_spec_promotion_state_pkey" primary key ("uuid"), constraint "skald_spec_promotion_state_two_clean_check" check (("state" = 'shadow' and "consecutive_clean_runs" = 0 and "last_clean_run_id" is null and "previous_clean_run_id" is null and "last_clean_completed_at" is null and "promoted_at" is null) or ("state" = 'canary_eligible' and "consecutive_clean_runs" = 1 and "last_clean_run_id" is not null and "previous_clean_run_id" is null and "last_clean_completed_at" is not null and "promoted_at" is null) or ("state" = 'promoted' and "consecutive_clean_runs" = 2 and "last_clean_run_id" is not null and "previous_clean_run_id" is not null and "last_clean_run_id" <> "previous_clean_run_id" and "last_clean_completed_at" is not null and "promoted_at" is not null)));`
        )
        this.addSql(
            `alter table "skald_spec_promotion_state" add constraint "skald_spec_promotion_state_project_uuid_key" unique ("project_id", "uuid");`
        )
        this.addSql(
            `alter table "skald_spec_promotion_state" add constraint "skald_spec_promotion_state_project_scope_key" unique ("project_id", "scope_key");`
        )
        this.addSql(`create index "skald_spec_promotion_state_project_id_idx" on "skald_spec_promotion_state" ("project_id");`)

        this.addSql(
            `create table "skald_spec_conflict_review_event" ("uuid" uuid not null, "candidate_key" varchar(512) not null, "left_revision_id" uuid not null, "right_revision_id" uuid not null, "left_evidence_hash" varchar(128) not null, "right_evidence_hash" varchar(128) not null, "actor_id" varchar(512) not null, "decision" varchar(100) not null, "reason" text not null, "request_id" varchar(512) not null, "supersedes_event_id" uuid null, "created_at" timestamptz not null, "project_id" uuid not null, constraint "skald_spec_conflict_review_event_pkey" primary key ("uuid"), constraint "skald_spec_conflict_review_event_distinct_revisions_check" check ("left_revision_id" <> "right_revision_id"), constraint "skald_spec_conflict_review_event_reason_check" check (length(btrim("reason")) > 0));`
        )
        this.addSql(
            `alter table "skald_spec_conflict_review_event" add constraint "skald_spec_conflict_review_event_project_uuid_key" unique ("project_id", "uuid");`
        )
        this.addSql(
            `alter table "skald_spec_conflict_review_event" add constraint "skald_spec_conflict_review_event_project_request_id_key" unique ("project_id", "request_id");`
        )
        this.addSql(`create index "skald_spec_conflict_review_event_project_id_idx" on "skald_spec_conflict_review_event" ("project_id");`)
        this.addSql(
            `create index "skald_spec_conflict_review_event_project_candidate_created_idx" on "skald_spec_conflict_review_event" ("project_id", "candidate_key", "created_at");`
        )

        this.addSql(
            `alter table "skald_spec_reconciliation_run" add constraint "skald_spec_reconciliation_run_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_promotion_state" add constraint "skald_spec_promotion_state_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_promotion_state" add constraint "skald_spec_promotion_state_last_clean_run_foreign" foreign key ("project_id", "scope_key", "last_clean_run_id") references "skald_spec_reconciliation_run" ("project_id", "scope_key", "run_id") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_promotion_state" add constraint "skald_spec_promotion_state_previous_clean_run_foreign" foreign key ("project_id", "scope_key", "previous_clean_run_id") references "skald_spec_reconciliation_run" ("project_id", "scope_key", "run_id") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_conflict_review_event" add constraint "skald_spec_conflict_review_event_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_conflict_review_event" add constraint "skald_spec_conflict_review_event_left_revision_foreign" foreign key ("project_id", "left_revision_id") references "skald_spec_revision" ("project_id", "uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_conflict_review_event" add constraint "skald_spec_conflict_review_event_right_revision_foreign" foreign key ("project_id", "right_revision_id") references "skald_spec_revision" ("project_id", "uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_conflict_review_event" add constraint "skald_spec_conflict_review_event_supersedes_foreign" foreign key ("project_id", "supersedes_event_id") references "skald_spec_conflict_review_event" ("project_id", "uuid") on update cascade deferrable initially deferred;`
        )

        this.addSql(
            `create function skald_spec_conflict_review_event_immutable() returns trigger language plpgsql as $$ begin raise exception 'skald_spec_conflict_review_event is append-only'; end; $$;`
        )
        this.addSql(
            `create trigger skald_spec_conflict_review_event_immutable before update or delete on "skald_spec_conflict_review_event" for each row execute function skald_spec_conflict_review_event_immutable();`
        )
    }

    override async down(): Promise<void> {
        this.addSql(`drop trigger if exists skald_spec_conflict_review_event_immutable on "skald_spec_conflict_review_event";`)
        this.addSql(`drop function if exists skald_spec_conflict_review_event_immutable();`)
        this.addSql(`drop table if exists "skald_spec_conflict_review_event" cascade;`)
        this.addSql(`drop table if exists "skald_spec_promotion_state" cascade;`)
        this.addSql(`drop table if exists "skald_spec_reconciliation_run" cascade;`)
    }
}
