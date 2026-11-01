import { dedupeAndCapChunks, dedupeAndCapResults, SearchResult } from '../lib/searchGraph'
import { MemoChunkWithDistance } from '../embeddings/vectorSearch'

function result(memoUuid: string, content: string, distance: number): SearchResult {
    return {
        chunk_uuid: `${memoUuid}-${content}`,
        memo_uuid: memoUuid,
        memo_title: `title-${memoUuid}`,
        memo_summary: '',
        content_snippet: content.slice(0, 100),
        chunk_content: content,
        distance,
    }
}

function chunk(memoUuid: string, content: string, distance: number): MemoChunkWithDistance {
    return {
        chunk: {
            uuid: `${memoUuid}-${content}`,
            chunk_content: content,
            chunk_index: 0,
            embedding: [],
            memo_uuid: memoUuid,
            project_uuid: 'project',
        },
        distance,
    }
}

describe('searchGraph result dedupe and per-memo cap', () => {
    it('drops identical chunk content even when the chunk rows are distinct', () => {
        const deduped = dedupeAndCapResults(
            [result('memo-a', 'same text', 0.1), result('memo-a', 'same text', 0.2), result('memo-b', 'other', 0.3)],
            3
        )

        expect(deduped.map((item) => `${item.memo_uuid}:${item.chunk_content}`)).toEqual([
            'memo-a:same text',
            'memo-b:other',
        ])
    })

    it('caps how many chunks one memo can contribute and keeps best-first order', () => {
        const deduped = dedupeAndCapResults(
            [
                result('memo-a', 'a1', 0.1),
                result('memo-a', 'a2', 0.2),
                result('memo-a', 'a3', 0.3),
                result('memo-a', 'a4', 0.4),
                result('memo-b', 'b1', 0.5),
            ],
            3
        )

        expect(deduped.map((item) => item.chunk_content)).toEqual(['a1', 'a2', 'a3', 'b1'])
        expect(deduped.filter((item) => item.memo_uuid === 'memo-a')).toHaveLength(3)
    })

    it('honours the result-window limit after capping', () => {
        const deduped = dedupeAndCapResults(
            [
                result('memo-a', 'a1', 0.1),
                result('memo-a', 'a2', 0.2),
                result('memo-b', 'b1', 0.3),
                result('memo-c', 'c1', 0.4),
            ],
            3,
            2
        )

        expect(deduped.map((item) => item.chunk_content)).toEqual(['a1', 'a2'])
    })

    it('applies the same dedupe and cap to pre-rerank candidates', () => {
        const deduped = dedupeAndCapChunks(
            [chunk('memo-a', 'a1', 0.1), chunk('memo-a', 'a1', 0.2), chunk('memo-a', 'a2', 0.3), chunk('memo-b', 'b1', 0.4)],
            1
        )

        expect(deduped.map((item) => `${item.chunk.memo_uuid}:${item.chunk.chunk_content}:${item.distance}`)).toEqual([
            'memo-a:a1:0.1',
            'memo-b:b1:0.4',
        ])
    })
})
