import { Migration } from '@mikro-orm/migrations'

export class Migration20260414120000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`alter table "skald_wiki_refresh_request" add column if not exists "claimed_at" timestamptz null;`)
        this.addSql(
            `alter table "skald_wiki_refresh_request" add column if not exists "claim_token" varchar(255) null;`
        )
        this.addSql(
            `alter table "skald_wiki_refresh_request" add column if not exists "priority" int not null default 100;`
        )
        this.addSql(`alter table "skald_wiki_refresh_request" add column if not exists "batch_key" varchar(255) null;`)
    }

    override async down(): Promise<void> {
        this.addSql(`alter table "skald_wiki_refresh_request" drop column if exists "batch_key";`)
        this.addSql(`alter table "skald_wiki_refresh_request" drop column if exists "priority";`)
        this.addSql(`alter table "skald_wiki_refresh_request" drop column if exists "claim_token";`)
        this.addSql(`alter table "skald_wiki_refresh_request" drop column if exists "claimed_at";`)
    }
}
