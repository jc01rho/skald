import { EntityManager } from '@mikro-orm/core'
import { sweepStuckMemos, StuckMemoSweepOptions } from '../memoProcessingServer/stuckMemoSweeper'

const options: StuckMemoSweepOptions = {
    receivedStaleMinutes: 10,
    processingStaleMinutes: 120,
    retryIntervalMinutes: 30,
    retryWindowHours: 72,
    batchSize: 200,
}

const createEm = (exhausted: string[], claimed: string[]) => {
    const execute = jest
        .fn()
        .mockResolvedValueOnce(exhausted.map((uuid) => ({ uuid })))
        .mockResolvedValueOnce(claimed.map((uuid) => ({ uuid })))
    const em = { getConnection: () => ({ execute }) } as unknown as EntityManager
    return { em, execute }
}

describe('sweepStuckMemos', () => {
    it('re-publishes claimed memos when the queue is idle', async () => {
        const { em, execute } = createEm(['expired'], ['memo-a', 'memo-b'])
        const publish = jest.fn().mockResolvedValue(undefined)

        const result = await sweepStuckMemos(em, options, { getReadyMessageCount: async () => 0, publish })

        expect(result).toEqual({ skipped: false, requeued: ['memo-a', 'memo-b'], exhausted: ['expired'] })
        expect(publish.mock.calls).toEqual([['memo-a'], ['memo-b']])
        expect(execute.mock.calls[1][1]).toEqual([10, 120, 30, 200])
    })

    it('does not claim or publish while the queue still has a backlog', async () => {
        const { em, execute } = createEm([], ['memo-a'])
        const publish = jest.fn()

        const result = await sweepStuckMemos(em, options, { getReadyMessageCount: async () => 5, publish })

        expect(result.skipped).toBe(true)
        expect(execute).toHaveBeenCalledTimes(1)
        expect(publish).not.toHaveBeenCalled()
    })

    it('keeps publishing the rest of the batch when one publish fails', async () => {
        const { em } = createEm([], ['memo-a', 'memo-b'])
        const publish = jest.fn().mockRejectedValueOnce(new Error('channel closed')).mockResolvedValueOnce(undefined)

        const result = await sweepStuckMemos(em, options, { getReadyMessageCount: async () => 0, publish })

        expect(result.requeued).toEqual(['memo-b'])
    })
})
