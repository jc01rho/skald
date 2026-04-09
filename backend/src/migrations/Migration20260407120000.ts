import { Migration } from '@mikro-orm/migrations'

export class Migration20260407120000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(
            `create table "skald_wiki_page" ("uuid" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "title" varchar(255) not null, "slug" varchar(255) not null, "content" text not null, "metadata" jsonb not null default '{}', "summary" text null, "revision_count" int not null default 1, "project_id" uuid not null, "created_by_id" bigint null, "updated_by_id" bigint null, constraint "skald_wiki_page_pkey" primary key ("uuid"));`
        )
        this.addSql(`create index "skald_wiki_page_project_id_idx" on "skald_wiki_page" ("project_id");`)
        this.addSql(`create index "skald_wiki_page_created_by_id_idx" on "skald_wiki_page" ("created_by_id");`)
        this.addSql(`create index "skald_wiki_page_updated_by_id_idx" on "skald_wiki_page" ("updated_by_id");`)
        this.addSql(
            `create index "skald_wiki_page_project_updated_idx" on "skald_wiki_page" ("project_id", "updated_at");`
        )
        this.addSql(
            `alter table "skald_wiki_page" add constraint "skald_wiki_page_project_slug_key" unique ("project_id", "slug");`
        )

        this.addSql(
            `create table "skald_wiki_page_revision" ("uuid" uuid not null, "created_at" timestamptz not null, "version" int not null, "title" varchar(255) not null, "slug" varchar(255) not null, "content" text not null, "metadata" jsonb not null default '{}', "summary" text null, "change_note" text null, "wiki_page_id" uuid not null, "project_id" uuid not null, "created_by_id" bigint null, constraint "skald_wiki_page_revision_pkey" primary key ("uuid"));`
        )
        this.addSql(
            `create index "skald_wiki_page_revision_page_id_idx" on "skald_wiki_page_revision" ("wiki_page_id");`
        )
        this.addSql(
            `create index "skald_wiki_page_revision_project_id_idx" on "skald_wiki_page_revision" ("project_id");`
        )
        this.addSql(
            `create index "skald_wiki_page_revision_created_by_id_idx" on "skald_wiki_page_revision" ("created_by_id");`
        )
        this.addSql(
            `create index "skald_wiki_page_revision_page_version_idx" on "skald_wiki_page_revision" ("wiki_page_id", "version");`
        )
        this.addSql(
            `alter table "skald_wiki_page_revision" add constraint "skald_wiki_page_revision_page_version_key" unique ("wiki_page_id", "version");`
        )
        this.addSql(
            `create index "skald_wiki_page_revision_project_created_idx" on "skald_wiki_page_revision" ("project_id", "created_at");`
        )

        this.addSql(
            `alter table "skald_wiki_page" add constraint "skald_wiki_page_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred ;`
        )
        this.addSql(
            `alter table "skald_wiki_page" add constraint "skald_wiki_page_created_by_id_foreign" foreign key ("created_by_id") references "skald_user" ("id") on update cascade on delete set null deferrable initially deferred ;`
        )
        this.addSql(
            `alter table "skald_wiki_page" add constraint "skald_wiki_page_updated_by_id_foreign" foreign key ("updated_by_id") references "skald_user" ("id") on update cascade on delete set null deferrable initially deferred ;`
        )
        this.addSql(
            `alter table "skald_wiki_page_revision" add constraint "skald_wiki_page_revision_page_id_foreign" foreign key ("wiki_page_id") references "skald_wiki_page" ("uuid") on update cascade deferrable initially deferred ;`
        )
        this.addSql(
            `alter table "skald_wiki_page_revision" add constraint "skald_wiki_page_revision_project_id_foreign" foreign key ("project_id") references "skald_project" ("uuid") on update cascade deferrable initially deferred ;`
        )
        this.addSql(
            `alter table "skald_wiki_page_revision" add constraint "skald_wiki_page_revision_created_by_id_foreign" foreign key ("created_by_id") references "skald_user" ("id") on update cascade on delete set null deferrable initially deferred ;`
        )
    }

    override async down(): Promise<void> {
        this.addSql(
            `alter table "skald_wiki_page_revision" drop constraint "skald_wiki_page_revision_page_id_foreign";`
        )
        this.addSql(
            `alter table "skald_wiki_page_revision" drop constraint "skald_wiki_page_revision_project_id_foreign";`
        )
        this.addSql(
            `alter table "skald_wiki_page_revision" drop constraint "skald_wiki_page_revision_created_by_id_foreign";`
        )
        this.addSql(
            `alter table "skald_wiki_page_revision" drop constraint "skald_wiki_page_revision_page_version_key";`
        )
        this.addSql(`alter table "skald_wiki_page" drop constraint "skald_wiki_page_project_id_foreign";`)
        this.addSql(`alter table "skald_wiki_page" drop constraint "skald_wiki_page_created_by_id_foreign";`)
        this.addSql(`alter table "skald_wiki_page" drop constraint "skald_wiki_page_updated_by_id_foreign";`)
        this.addSql(`drop table if exists "skald_wiki_page_revision" cascade;`)
        this.addSql(`drop table if exists "skald_wiki_page" cascade;`)
    }
}
