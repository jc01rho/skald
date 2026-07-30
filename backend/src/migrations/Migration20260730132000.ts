import { Migration } from '@mikro-orm/migrations'

export class Migration20260730132000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(
            `create table "skald_spec_lifecycle_event" ("uuid" uuid not null, "scope_key" varchar(512) not null, "memo_reference_id" varchar(512) not null, "memo_id" uuid not null, "run_id" varchar(512) not null, "manifest_hash" varchar(128) not null, "absent" boolean not null, "disposition" varchar(32) not null, "reason" text not null, "observed_at" timestamptz not null, "exact_refetch_reference_id" varchar(512) null, "exact_refetch_outcome" varchar(32) null, "exact_refetch_certificate_hash" varchar(128) null, "first_absence_run_id" varchar(512) null, "first_absence_observed_at" timestamptz null, "created_at" timestamptz not null, "project_id" uuid not null, constraint "skald_spec_lifecycle_event_pkey" primary key ("uuid"), constraint "skald_spec_lifecycle_event_disposition_check" check ("disposition" in ('present', 'quarantined', 'tombstoned')), constraint "skald_spec_lifecycle_event_refetch_check" check (("exact_refetch_reference_id" is null and "exact_refetch_outcome" is null and "exact_refetch_certificate_hash" is null) or ("exact_refetch_reference_id" = "memo_reference_id" and "exact_refetch_outcome" = 'absent' and "exact_refetch_certificate_hash" is not null)), constraint "skald_spec_lifecycle_event_tombstone_check" check ("disposition" <> 'tombstoned' or ("absent" and "first_absence_run_id" is not null and "first_absence_observed_at" is not null and "first_absence_run_id" <> "run_id" and "observed_at" >= "first_absence_observed_at" + interval '24 hours' and "exact_refetch_outcome" = 'absent')), constraint "skald_spec_lifecycle_event_presence_check" check (("absent" and "disposition" in ('quarantined', 'tombstoned')) or (not "absent" and "disposition" = 'present')));`
        )
        this.addSql(
            `alter table "skald_spec_lifecycle_event" add constraint "skald_spec_lifecycle_event_project_scope_memo_run_key" unique ("project_id", "scope_key", "memo_reference_id", "run_id");`
        )
        this.addSql(
            `create index "skald_spec_lifecycle_event_project_scope_memo_observed_idx" on "skald_spec_lifecycle_event" ("project_id", "scope_key", "memo_reference_id", "observed_at");`
        )
        this.addSql(
            `alter table "skald_spec_lifecycle_event" add constraint "skald_spec_lifecycle_event_project_run_foreign" foreign key ("project_id", "scope_key", "run_id") references "skald_spec_reconciliation_run" ("project_id", "scope_key", "run_id") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_lifecycle_event" add constraint "skald_spec_lifecycle_event_project_memo_foreign" foreign key ("project_id", "memo_id", "memo_reference_id") references "skald_memo" ("project_id", "uuid", "client_reference_id") on update cascade deferrable initially deferred;`
        )

        this.addSql(`alter table "skald_spec_conflict_review_event" add column "left_claim_id" uuid null;`)
        this.addSql(`alter table "skald_spec_conflict_review_event" add column "right_claim_id" uuid null;`)
        this.addSql(
            `alter table "skald_spec_conflict_review_event" add constraint "skald_spec_conflict_review_event_left_claim_foreign" foreign key ("project_id", "left_claim_id") references "skald_spec_claim" ("project_id", "uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_conflict_review_event" add constraint "skald_spec_conflict_review_event_right_claim_foreign" foreign key ("project_id", "right_claim_id") references "skald_spec_claim" ("project_id", "uuid") on update cascade deferrable initially deferred;`
        )
        this.addSql(
            `alter table "skald_spec_conflict_review_event" add constraint "skald_spec_conflict_review_event_distinct_claims_check" check ("left_claim_id" is null or "right_claim_id" is null or "left_claim_id" <> "right_claim_id");`
        )

        this.addSql(
            `create function skald_spec_lifecycle_event_immutable() returns trigger language plpgsql as $$ begin raise exception 'skald_spec_lifecycle_event is append-only'; end; $$;`
        )
        this.addSql(
            `create trigger skald_spec_lifecycle_event_immutable before update or delete on "skald_spec_lifecycle_event" for each row execute function skald_spec_lifecycle_event_immutable();`
        )
    }

    override async down(): Promise<void> {
        this.addSql(`drop trigger if exists skald_spec_lifecycle_event_immutable on "skald_spec_lifecycle_event";`)
        this.addSql(`drop function if exists skald_spec_lifecycle_event_immutable();`)
        this.addSql(`alter table "skald_spec_conflict_review_event" drop constraint if exists "skald_spec_conflict_review_event_distinct_claims_check";`)
        this.addSql(`alter table "skald_spec_conflict_review_event" drop constraint if exists "skald_spec_conflict_review_event_left_claim_foreign";`)
        this.addSql(`alter table "skald_spec_conflict_review_event" drop constraint if exists "skald_spec_conflict_review_event_right_claim_foreign";`)
        this.addSql(`alter table "skald_spec_conflict_review_event" drop column if exists "left_claim_id";`)
        this.addSql(`alter table "skald_spec_conflict_review_event" drop column if exists "right_claim_id";`)
        this.addSql(`drop table if exists "skald_spec_lifecycle_event" cascade;`)
    }
}
