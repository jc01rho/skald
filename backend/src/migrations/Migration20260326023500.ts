import { Migration } from '@mikro-orm/migrations'

export class Migration20260326023500 extends Migration {
    async up(): Promise<void> {
        this.addSql(`alter table "skald_memo_submission" add column "summary" text null;`)
        this.addSql(`alter table "skald_memo_submission" add column "metadata" jsonb null;`)
        this.addSql(`alter table "skald_memo_submission" add column "tags" jsonb null;`)
        this.addSql(`alter table "skald_memo_submission" add column "source" varchar(255) null;`)
        this.addSql(`alter table "skald_memo_submission" add column "type" varchar(100) null;`)
        this.addSql(`alter table "skald_memo_submission" add column "reference_id" varchar(255) null;`)
        this.addSql(`alter table "skald_memo_submission" add column "submitter_name" varchar(255) null;`)
        this.addSql(`alter table "skald_memo_submission" add column "submitter_email" varchar(255) null;`)
        this.addSql(`alter table "skald_memo_submission" add column "file_name" varchar(500) null;`)
        this.addSql(`alter table "skald_memo_submission" add column "expiration_date" timestamptz null;`)
    }

    async down(): Promise<void> {
        this.addSql(`alter table "skald_memo_submission" drop column "expiration_date";`)
        this.addSql(`alter table "skald_memo_submission" drop column "file_name";`)
        this.addSql(`alter table "skald_memo_submission" drop column "submitter_email";`)
        this.addSql(`alter table "skald_memo_submission" drop column "submitter_name";`)
        this.addSql(`alter table "skald_memo_submission" drop column "reference_id";`)
        this.addSql(`alter table "skald_memo_submission" drop column "type";`)
        this.addSql(`alter table "skald_memo_submission" drop column "source";`)
        this.addSql(`alter table "skald_memo_submission" drop column "tags";`)
        this.addSql(`alter table "skald_memo_submission" drop column "metadata";`)
        this.addSql(`alter table "skald_memo_submission" drop column "summary";`)
    }
}
