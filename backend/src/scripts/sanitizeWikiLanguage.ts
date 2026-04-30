import { DI, initDI } from '@/di'
import {
    hasKnownWikiLanguageContamination,
    replaceKnownWikiLanguageContamination,
    sanitizeGeneratedWikiKoreanText,
} from '@/services/wiki/wikiLanguageSanitizer'

interface Options {
    dryRun: boolean
    apply: boolean
    projectUuid: string | null
    limit: number | null
}

interface ChangePreview {
    table: string
    uuid: string
    field: string
    before: string
    after: string
}

function parseOptions(argv: string[]): Options {
    const options: Options = {
        dryRun: true,
        apply: false,
        projectUuid: null,
        limit: null,
    }

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--') {
            continue
        }

        if (arg === '--dry-run') {
            options.dryRun = true
            continue
        }

        if (arg === '--apply') {
            options.apply = true
            options.dryRun = false
            continue
        }

        if (arg === '--project-uuid') {
            const projectUuid = argv[++i]
            if (!projectUuid) {
                throw new Error('project-uuid requires a value')
            }
            options.projectUuid = projectUuid
            continue
        }

        if (arg === '--limit') {
            const parsedLimit = parseInt(argv[++i] || '', 10)
            if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
                throw new Error('limit must be a positive integer')
            }
            options.limit = parsedLimit
            continue
        }

        throw new Error(`Unknown argument: ${arg}`)
    }

    if (options.apply && !options.projectUuid) {
        throw new Error('apply mode requires --project-uuid to limit production data changes')
    }

    return options
}

function maybeSanitize(value: string | null | undefined): string | null | undefined {
    if (!value || !hasKnownWikiLanguageContamination(value)) {
        return value
    }

    const sanitized = sanitizeGeneratedWikiKoreanText(value)
    return sanitized || value
}

function maybeSanitizeCanonical(value: string | null | undefined): string | null | undefined {
    if (!value || !hasKnownWikiLanguageContamination(value)) {
        return value
    }

    const sanitized = replaceKnownWikiLanguageContamination(value)
    return sanitized || value
}

function recordChange(
    changes: ChangePreview[],
    table: string,
    uuid: string,
    field: string,
    before: string,
    after: string
) {
    if (before === after) {
        return
    }

    changes.push({ table, uuid, field, before, after })
}

async function sanitizePages(options: Options, changes: ChangePreview[]): Promise<number> {
    const pages = await DI.wikiPages.find(
        {
            ...(options.projectUuid ? { project: options.projectUuid } : {}),
        },
        { limit: options.limit || undefined, orderBy: { updated_at: 'DESC' } }
    )
    let changed = 0

    for (const page of pages) {
        const nextTitle = maybeSanitize(page.title)
        const nextSummary = maybeSanitize(page.summary)
        const nextContent = maybeSanitize(page.content)
        const nextCanonical = maybeSanitizeCanonical(page.canonical)
        let touched = false

        if (nextTitle && nextTitle !== page.title) {
            recordChange(changes, 'skald_wiki_page', page.uuid, 'title', page.title, nextTitle)
            page.title = nextTitle
            touched = true
        }
        if (nextSummary !== page.summary) {
            recordChange(changes, 'skald_wiki_page', page.uuid, 'summary', page.summary || '', nextSummary || '')
            page.summary = nextSummary || null
            touched = true
        }
        if (nextContent && nextContent !== page.content) {
            recordChange(changes, 'skald_wiki_page', page.uuid, 'content', page.content, nextContent)
            page.content = nextContent
            touched = true
        }
        if (nextCanonical !== page.canonical) {
            recordChange(changes, 'skald_wiki_page', page.uuid, 'canonical', page.canonical || '', nextCanonical || '')
            page.canonical = nextCanonical || null
            touched = true
        }

        if (touched) {
            page.updated_at = new Date()
            changed += 1
        }
    }

    return changed
}

async function sanitizeNodes(options: Options, changes: ChangePreview[]): Promise<number> {
    const nodes = await DI.wikiNodes.find(
        {
            ...(options.projectUuid ? { project: options.projectUuid } : {}),
        },
        { limit: options.limit || undefined, orderBy: { updated_at: 'DESC' } }
    )
    let changed = 0

    for (const node of nodes) {
        const nextDisplayName = maybeSanitize(node.display_name)
        const nextDescription = maybeSanitize(node.description)
        let touched = false

        if (nextDisplayName && nextDisplayName !== node.display_name) {
            recordChange(changes, 'skald_wiki_node', node.uuid, 'display_name', node.display_name, nextDisplayName)
            node.display_name = nextDisplayName
            touched = true
        }
        if (nextDescription !== node.description) {
            recordChange(
                changes,
                'skald_wiki_node',
                node.uuid,
                'description',
                node.description || '',
                nextDescription || ''
            )
            node.description = nextDescription || null
            touched = true
        }

        if (touched) {
            node.updated_at = new Date()
            changed += 1
        }
    }

    return changed
}

async function sanitizeClaims(options: Options, changes: ChangePreview[]): Promise<number> {
    const claims = await DI.wikiClaims.find(
        {
            ...(options.projectUuid ? { project: options.projectUuid } : {}),
        },
        { limit: options.limit || undefined, orderBy: { updated_at: 'DESC' } }
    )
    let changed = 0

    for (const claim of claims) {
        const nextClaimText = maybeSanitize(claim.claim_text)
        if (nextClaimText && nextClaimText !== claim.claim_text) {
            recordChange(changes, 'skald_wiki_claim', claim.uuid, 'claim_text', claim.claim_text, nextClaimText)
            claim.claim_text = nextClaimText
            claim.updated_at = new Date()
            changed += 1
        }
    }

    return changed
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2))
    await initDI()

    const changes: ChangePreview[] = []
    const pageCount = await sanitizePages(options, changes)
    const nodeCount = await sanitizeNodes(options, changes)
    const claimCount = await sanitizeClaims(options, changes)

    console.log(
        JSON.stringify(
            {
                dryRun: options.dryRun,
                apply: options.apply,
                projectUuid: options.projectUuid,
                changed: {
                    pages: pageCount,
                    nodes: nodeCount,
                    claims: claimCount,
                    fields: changes.length,
                },
                preview: changes.slice(0, 20),
            },
            null,
            2
        )
    )

    if (!options.dryRun && changes.length > 0) {
        await DI.em.flush()
    }

    await DI.orm.close(true)
}

main().catch(async (error) => {
    console.error(error)
    if (DI.orm) {
        await DI.orm.close(true)
    }
    process.exit(1)
})

export { parseOptions, sanitizePages, sanitizeNodes, sanitizeClaims }
