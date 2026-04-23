import { DI, initDI } from '@/di'
import { logger } from '@/lib/logger'

interface ScriptOptions {
    execute: boolean
    projectUuid: string | null
}

interface TargetMemoRow {
    memo_uuid: string
    raw_source_document_uuid: string | null
    page_count: number
}

function asUuidArray(values: string[]): string {
    return `{${values.join(',')}}`
}

function parseOptions(argv: string[]): ScriptOptions {
    const options: ScriptOptions = {
        execute: false,
        projectUuid: null,
    }

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]

        if (arg === '--execute') {
            options.execute = true
            continue
        }

        if (arg === '--project-uuid') {
            const projectUuid = argv[i + 1]
            if (!projectUuid) {
                throw new Error('--project-uuid requires a value')
            }
            options.projectUuid = projectUuid
            i += 1
            continue
        }

        if (arg === '--dry-run') {
            options.execute = false
            continue
        }

        throw new Error(`Unknown argument: ${arg}`)
    }

    return options
}

async function loadTargetRows(projectUuid: string | null): Promise<TargetMemoRow[]> {
    const params: Array<string | number> = []
    const projectFilter = projectUuid ? 'AND m.project_id = ?' : ''
    if (projectUuid) {
        params.push(projectUuid)
    }

    return DI.em.getConnection().execute<TargetMemoRow[]>(
        `
        SELECT
            m.uuid AS memo_uuid,
            rsd.uuid AS raw_source_document_uuid,
            COUNT(DISTINCT wp.uuid)::int AS page_count
        FROM skald_memo m
        INNER JOIN skald_memocontent mc
            ON mc.memo_id = m.uuid
        LEFT JOIN skald_raw_source_document rsd
            ON rsd.external_reference::uuid = m.uuid
           AND rsd.project_id = m.project_id
           AND rsd.source_type = CASE WHEN m.type = 'document' THEN 'document' ELSE 'memo' END
        LEFT JOIN skald_wiki_page wp
            ON wp.project_id = m.project_id
           AND wp.metadata ->> 'sourceDocumentUuid' = rsd.uuid::text
        WHERE m.source = 'notion'
          AND char_length(btrim(mc.content)) < 200
          ${projectFilter}
        GROUP BY m.uuid, rsd.uuid
        ORDER BY m.uuid ASC
        `,
        params
    )
}

async function deleteTargets(targetRows: TargetMemoRow[]): Promise<void> {
    const memoUuids = targetRows.map((row) => row.memo_uuid)
    const rawSourceDocumentUuids = targetRows
        .map((row) => row.raw_source_document_uuid)
        .filter((uuid): uuid is string => Boolean(uuid))
    const memoUuidArray = asUuidArray(memoUuids)
    const rawSourceDocumentUuidArray = asUuidArray(rawSourceDocumentUuids)

    if (memoUuids.length === 0) {
        return
    }

    await DI.em.transactional(async (em) => {
        if (rawSourceDocumentUuids.length > 0) {
            await em.getConnection().execute(
                `
                DELETE FROM skald_wiki_claim_source_ref
                WHERE source_ref_id IN (
                    SELECT uuid
                    FROM skald_wiki_source_ref
                    WHERE raw_source_document_id = ANY(?::uuid[])
                )
                `,
                [rawSourceDocumentUuidArray]
            )

            await em
                .getConnection()
                .execute(`DELETE FROM skald_wiki_source_ref WHERE raw_source_document_id = ANY(?::uuid[])`, [
                    rawSourceDocumentUuidArray,
                ])

            await em
                .getConnection()
                .execute(`DELETE FROM skald_wiki_page_source_link WHERE raw_source_document_id = ANY(?::uuid[])`, [
                    rawSourceDocumentUuidArray,
                ])

            await em
                .getConnection()
                .execute(`DELETE FROM skald_wiki_refresh_request WHERE raw_source_document_id = ANY(?::uuid[])`, [
                    rawSourceDocumentUuidArray,
                ])

            await em
                .getConnection()
                .execute(
                    `DELETE FROM skald_wiki_page_link WHERE from_page_id IN (SELECT uuid FROM skald_wiki_page WHERE metadata ->> 'sourceDocumentUuid' = ANY(?::text[])) OR to_page_id IN (SELECT uuid FROM skald_wiki_page WHERE metadata ->> 'sourceDocumentUuid' = ANY(?::text[]))`,
                    [rawSourceDocumentUuidArray, rawSourceDocumentUuidArray]
                )

            await em
                .getConnection()
                .execute(
                    `DELETE FROM skald_wiki_claim WHERE page_id IN (SELECT uuid FROM skald_wiki_page WHERE metadata ->> 'sourceDocumentUuid' = ANY(?::text[]))`,
                    [rawSourceDocumentUuidArray]
                )

            await em
                .getConnection()
                .execute(
                    `DELETE FROM skald_wiki_page_revision WHERE wiki_page_id IN (SELECT uuid FROM skald_wiki_page WHERE metadata ->> 'sourceDocumentUuid' = ANY(?::text[]))`,
                    [rawSourceDocumentUuidArray]
                )

            await em
                .getConnection()
                .execute(`DELETE FROM skald_wiki_page WHERE metadata ->> 'sourceDocumentUuid' = ANY(?::text[])`, [
                    rawSourceDocumentUuidArray,
                ])

            await em
                .getConnection()
                .execute(`DELETE FROM skald_raw_source_content WHERE raw_source_document_id = ANY(?::uuid[])`, [
                    rawSourceDocumentUuidArray,
                ])

            await em
                .getConnection()
                .execute(`DELETE FROM skald_raw_source_document WHERE uuid = ANY(?::uuid[])`, [
                    rawSourceDocumentUuidArray,
                ])
        }

        await em.getConnection().execute(`DELETE FROM skald_memochunk WHERE memo_id = ANY(?::uuid[])`, [memoUuidArray])
        await em
            .getConnection()
            .execute(`DELETE FROM skald_memoparentchunk WHERE memo_id = ANY(?::uuid[])`, [memoUuidArray])
        await em
            .getConnection()
            .execute(`DELETE FROM skald_memosummary WHERE memo_id = ANY(?::uuid[])`, [memoUuidArray])
        await em.getConnection().execute(`DELETE FROM skald_memotag WHERE memo_id = ANY(?::uuid[])`, [memoUuidArray])
        await em
            .getConnection()
            .execute(`DELETE FROM skald_memocontent WHERE memo_id = ANY(?::uuid[])`, [memoUuidArray])
        await em.getConnection().execute(`DELETE FROM skald_memo WHERE uuid = ANY(?::uuid[])`, [memoUuidArray])
    })
}

async function main() {
    const options = parseOptions(process.argv.slice(2))
    await initDI()

    const targetRows = await loadTargetRows(options.projectUuid)
    const memoCount = targetRows.length
    const rawSourceDocumentCount = targetRows.filter((row) => row.raw_source_document_uuid).length
    const wikiPageCount = targetRows.reduce((sum, row) => sum + Number(row.page_count || 0), 0)

    logger.info(
        {
            execute: options.execute,
            projectUuid: options.projectUuid,
            memoCount,
            rawSourceDocumentCount,
            wikiPageCount,
            sampleMemoUuids: targetRows.slice(0, 10).map((row) => row.memo_uuid),
        },
        options.execute
            ? 'Deleting Notion-origin content under 200 characters'
            : 'Dry run for deleting Notion-origin content under 200 characters'
    )

    if (!options.execute || memoCount === 0) {
        return
    }

    await deleteTargets(targetRows)

    logger.info(
        {
            deletedMemoCount: memoCount,
            deletedRawSourceDocumentCount: rawSourceDocumentCount,
            deletedWikiPageCount: wikiPageCount,
        },
        'Completed deletion of Notion-origin content under 200 characters'
    )
}

main()
    .catch((error) => {
        logger.error({ err: error }, 'deleteShortNotionContent script failed')
        process.exitCode = 1
    })
    .finally(async () => {
        if (DI.orm) {
            await DI.orm.close(true)
        }
    })
