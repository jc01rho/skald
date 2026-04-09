import { DI, initDI } from '@/di'
import { Memo } from '@/entities/Memo'
import { ProjectSweepState } from '@/entities/ProjectSweepState'
import { logger } from '@/lib/logger'
import { publishWikiRefresh } from '@/lib/wikiQueueClient'
import { WikiCompilerService } from '@/services/wiki/wikiCompilerService'
import { WIKI_ASYNC_MODE } from '@/settings'
import { randomUUID } from 'crypto'

interface BackfillOptions {
    batchSize: number
    delayMs: number
    limit: number | null
    projectUuid: string | null
    dryRun: boolean
    resumeFrom: number
    createdWithinHours: number | null
    trigger: 'manual' | 'scheduled'
    fullCorpusSweep: boolean
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
    if (!value) {
        return fallback
    }

    const parsed = parseInt(value, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer`)
    }

    return parsed
}

function parseOptions(argv: string[]): BackfillOptions {
    const options: BackfillOptions = {
        batchSize: 50,
        delayMs: 2000,
        limit: null,
        projectUuid: null,
        dryRun: false,
        resumeFrom: 0,
        createdWithinHours: null,
        trigger: 'manual',
        fullCorpusSweep: false,
    }

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]

        if (arg === '--') {
            continue
        }

        if (arg === '--batch-size') {
            options.batchSize = parsePositiveInt(argv[++i], options.batchSize, 'batch-size')
            continue
        }

        if (arg === '--delay-ms') {
            const parsedDelay = parseInt(argv[++i] || '', 10)
            if (!Number.isFinite(parsedDelay) || parsedDelay < 0) {
                throw new Error('delay-ms must be a non-negative integer')
            }
            options.delayMs = parsedDelay
            continue
        }

        if (arg === '--limit') {
            options.limit = parsePositiveInt(argv[++i], 1, 'limit')
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

        if (arg === '--resume-from') {
            const parsedOffset = parseInt(argv[++i] || '', 10)
            if (!Number.isFinite(parsedOffset) || parsedOffset < 0) {
                throw new Error('resume-from must be a non-negative integer')
            }
            options.resumeFrom = parsedOffset
            continue
        }

        if (arg === '--created-within-hours') {
            options.createdWithinHours = parsePositiveInt(argv[++i], 1, 'created-within-hours')
            continue
        }

        if (arg === '--scheduled') {
            options.trigger = 'scheduled'
            continue
        }

        if (arg === '--full-corpus-sweep') {
            options.fullCorpusSweep = true
            options.trigger = 'scheduled'
            options.createdWithinHours = null
            continue
        }

        if (arg === '--dry-run') {
            options.dryRun = true
            continue
        }

        throw new Error(`Unknown argument: ${arg}`)
    }

    if (options.fullCorpusSweep && !options.projectUuid) {
        throw new Error('full-corpus-sweep requires --project-uuid because the rolling cursor is stored per project')
    }

    return options
}

async function delay(ms: number): Promise<void> {
    if (ms <= 0) {
        return
    }

    await new Promise((resolve) => setTimeout(resolve, ms))
}

async function wakeQueuedProjects(projectUuids: string[]): Promise<void> {
    for (const projectUuid of projectUuids) {
        await publishWikiRefresh({
            project_uuid: projectUuid,
            reason: 'batch_tick',
        })
    }
}

async function loadProjectSweepState(projectUuid: string): Promise<ProjectSweepState | null> {
    return DI.projectSweepStates.findOne({
        project: projectUuid,
        sweep_type: 'wiki_full_corpus',
    })
}

async function ensureProjectSweepState(projectUuid: string): Promise<ProjectSweepState> {
    const existing = await loadProjectSweepState(projectUuid)
    if (existing) {
        return existing
    }

    const project = await DI.projects.findOne({ uuid: projectUuid })
    if (!project) {
        throw new Error(`Project not found for sweep state: ${projectUuid}`)
    }

    const now = new Date()
    const state = DI.projectSweepStates.create({
        uuid: randomUUID(),
        created_at: now,
        updated_at: now,
        sweep_type: 'wiki_full_corpus',
        next_offset: 0,
        metadata: null,
        project,
    })
    await DI.projectSweepStates.getEntityManager().persistAndFlush(state)
    return state
}

async function resolveInitialOffset(options: BackfillOptions, totalMemos: number): Promise<number> {
    if (!options.fullCorpusSweep || !options.projectUuid) {
        return options.resumeFrom >= totalMemos ? 0 : options.resumeFrom
    }

    const state = await ensureProjectSweepState(options.projectUuid)
    return state.next_offset >= totalMemos ? 0 : state.next_offset
}

async function updateSweepState(options: BackfillOptions, offset: number, totalMemos: number): Promise<void> {
    if (!options.fullCorpusSweep || !options.projectUuid || options.dryRun) {
        return
    }

    const state = await ensureProjectSweepState(options.projectUuid)
    state.next_offset = totalMemos === 0 || offset >= totalMemos ? 0 : offset
    state.updated_at = new Date()
    state.metadata = {
        ...(state.metadata || {}),
        lastTrigger: options.trigger,
        lastBatchSize: options.batchSize,
        lastDelayMs: options.delayMs,
        lastAdvancedAt: state.updated_at.toISOString(),
    }
    await DI.projectSweepStates.getEntityManager().persistAndFlush(state)
}

async function backfillWikiForMemos() {
    const options = parseOptions(process.argv.slice(2))
    const createdAfter =
        options.createdWithinHours !== null ? new Date(Date.now() - options.createdWithinHours * 60 * 60 * 1000) : null

    logger.info({ options }, 'Starting throttled wiki backfill for existing memos')

    await initDI()
    const em = DI.em.fork()

    try {
        const wikiEnabled = WikiCompilerService.isEnabled()
        if (!wikiEnabled) {
            logger.warn(
                { wikiAsyncMode: WIKI_ASYNC_MODE },
                'Wiki backfill is disabled by configuration; requests will be skipped until wiki compile on memo process is enabled'
            )
        }

        const where: Record<string, unknown> = {}
        if (options.projectUuid) {
            where.project = options.projectUuid
        }
        if (createdAfter && !options.fullCorpusSweep) {
            where.created_at = { $gte: createdAfter }
        }

        const totalMemos = await em.count(Memo, where)
        const initialOffset = await resolveInitialOffset(options, totalMemos)
        const remainingFromOffset = Math.max(totalMemos - initialOffset, 0)
        const totalTarget = options.limit ? Math.min(remainingFromOffset, options.limit) : remainingFromOffset

        logger.info(
            {
                totalMemos,
                totalTarget,
                batchSize: options.batchSize,
                delayMs: options.delayMs,
                projectUuid: options.projectUuid,
                dryRun: options.dryRun,
                resumeFrom: options.resumeFrom,
                initialOffset,
                createdWithinHours: options.createdWithinHours,
                createdAfter,
                trigger: options.trigger,
                fullCorpusSweep: options.fullCorpusSweep,
            },
            'Wiki backfill scope resolved'
        )

        if (totalTarget === 0) {
            logger.info('No memos selected for wiki backfill')
            return
        }

        let offset = initialOffset
        let scanned = 0
        let queued = 0
        let skipped = 0
        let failed = 0

        while (offset < totalTarget) {
            const limit = Math.min(options.batchSize, totalTarget - offset)
            const memos = await em.find(Memo, where, {
                limit,
                offset,
                orderBy: { created_at: 'ASC' },
                fields: ['uuid', 'created_at'],
            })

            if (memos.length === 0) {
                break
            }

            logger.info(
                {
                    batch: Math.floor(offset / options.batchSize) + 1,
                    batchSize: memos.length,
                    offset,
                    progress: `${Math.min(offset + memos.length, totalTarget)}/${totalTarget}`,
                },
                'Processing wiki backfill batch'
            )

            const queuedProjects = new Set<string>()

            for (const memo of memos) {
                scanned++

                try {
                    if (options.dryRun) {
                        queued++
                        logger.info({ memoUuid: memo.uuid }, 'Dry-run: memo would be queued for wiki backfill')
                        continue
                    }

                    const refreshRequest = await WikiCompilerService.enqueueRefreshForMemo(
                        em,
                        memo.uuid,
                        options.trigger
                    )

                    if (!refreshRequest) {
                        skipped++
                        logger.info(
                            { memoUuid: memo.uuid },
                            'Skipped memo for wiki backfill (wiki disabled or no content)'
                        )
                        continue
                    }

                    queuedProjects.add(refreshRequest.project.uuid)
                    queued++
                    logger.info(
                        {
                            memoUuid: memo.uuid,
                            requestUuid: refreshRequest.uuid,
                            progress: `${scanned}/${totalTarget}`,
                        },
                        'Queued memo for wiki backfill'
                    )
                } catch (error) {
                    failed++
                    logger.error({ memoUuid: memo.uuid, error }, 'Failed to queue memo for wiki backfill')
                }
            }

            if (!options.dryRun && WIKI_ASYNC_MODE === 'queue' && queuedProjects.size > 0) {
                await wakeQueuedProjects([...queuedProjects])
            }

            offset += memos.length

            logger.info(
                { scanned, queued, skipped, failed, remaining: Math.max(totalTarget - offset, 0) },
                'Completed wiki backfill batch'
            )

            if (offset < totalTarget) {
                await delay(options.delayMs)
            }
        }

        logger.info({ totalTarget, scanned, queued, skipped, failed, dryRun: options.dryRun }, 'Wiki backfill finished')
        await updateSweepState(options, offset, totalMemos)

        if (!options.dryRun) {
            logger.info(
                'Note: actual wiki compilation proceeds asynchronously via wiki-processing-server when queue mode is enabled'
            )
        }
    } finally {
        await DI.orm.close()
    }
}

backfillWikiForMemos()
    .then(() => {
        logger.info('Wiki backfill script completed successfully')
        process.exit(0)
    })
    .catch((error) => {
        logger.error({ error }, 'Wiki backfill script failed')
        process.exit(1)
    })
