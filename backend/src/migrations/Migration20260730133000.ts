import { Migration } from '@mikro-orm/migrations'

export class Migration20260730133000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(
            `alter table "skald_spec_traversal_snapshot" add column "auth_scope_hash" varchar(64) null, add column "graph_watermark" timestamptz null, add column "promotion_watermark" timestamptz null;`
        )
        this.addSql(
            `update "skald_spec_traversal_snapshot" set "auth_scope_hash" = md5('legacy:' || "project_id"::text) || md5("project_id"::text || ':legacy') where "auth_scope_hash" is null;`
        )
        this.addSql(`alter table "skald_spec_traversal_snapshot" alter column "auth_scope_hash" set not null;`)
    }

    override async down(): Promise<void> {
        this.addSql(
            `alter table "skald_spec_traversal_snapshot" drop column "auth_scope_hash", drop column "graph_watermark", drop column "promotion_watermark";`
        )
    }
}
