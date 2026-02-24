import { Request, Response } from 'express'
import { parseFilter } from '@/lib/filterUtils'
import { MemoFilter } from '@/lib/filterUtils'
import { DI } from '@/di'
import { SearchRequest } from '@/entities/SearchRequest'
import { randomUUID } from 'crypto'
import * as Sentry from '@sentry/node'
import { searchGraph, SearchResult } from '../lib/searchGraph'
import { posthogCapture } from '@/lib/posthogUtils'
import { checkAndQueueLazyReprocess } from '@/lib/lazyReprocessService'
import { logger } from '@/lib/logger'

export const search = async (req: Request, res: Response) => {
    const query = req.body.query
    const limit = req.body.limit || 10
    const filters = req.body.filters || []

    const project = req.context?.requestUser?.project

    if (!project) {
        return res.status(400).json({ error: 'Project is required' })
    }

    if (!query) {
        return res.status(400).json({ error: 'Query is required' })
    }

    if (limit > 50) {
        return res.status(400).json({ error: 'Limit must be less than or equal to 50' })
    }

    const memoFilters: MemoFilter[] = []
    for (const filter of filters) {
        const { filter: memoFilter, error } = parseFilter(filter)
        if (memoFilter && !error) {
            memoFilters.push(memoFilter)
        } else {
            return res.status(400).json({ error: `Invalid filter: ${error}` })
        }
    }

    const initialState = {
        project,
        query,
        limit,
        filters: memoFilters,
        chunkResults: null,
        memoPropertiesMap: null,
        rerankedResults: [],
        results: [],
    }

    const finalState = await searchGraph.invoke(initialState)
    const results: SearchResult[] = finalState.results

    const createSearchRequest = async () => {
        try {
            const searchRequest = DI.em.create(SearchRequest, {
                uuid: randomUUID(),
                project,
                query,
                filters,
                results: results.map((result) => ({
                    chunk_uuid: result.chunk_uuid,
                    memo_title: result.memo_title,
                    distance: result.distance,
                })),
                created_at: new Date(),
            })
            await DI.em.persistAndFlush(searchRequest)
        } catch (error) {
            Sentry.captureException(error)
        }
    }

    posthogCapture({
        event: 'search_api_call',
        distinctId: req.context?.requestUser?.userInstance?.email || `project:${project.uuid}`,
        groups: {
            organization: project.organization.uuid,
        },
        properties: {
            query: query,
            limit: limit,
            filters: filters,
        },
    })

    void createSearchRequest()

    // Fire-and-forget lazy reprocessing (don't await to avoid response delay)
    const memoUuids = results.map((r) => r.memo_uuid).filter(Boolean)
    if (memoUuids.length > 0) {
        checkAndQueueLazyReprocess(memoUuids, project.uuid).catch((err) => {
            logger.warn({ err }, 'Search: lazy reprocess failed to trigger (non-blocking)')
        })
    }

    return res.status(200).json({ results })
}
