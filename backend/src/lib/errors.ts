/**
 * Custom error classes for the application
 */

/**
 * Error thrown when a memo is not found in the database.
 * This error should NOT trigger retry logic in queue consumers
 * because the memo will never exist.
 */
export class MemoNotFoundError extends Error {
    public readonly memoUuid: string

    constructor(memoUuid: string) {
        super(`Memo not found: ${memoUuid}`)
        this.name = 'MemoNotFoundError'
        this.memoUuid = memoUuid
    }
}

/**
 * Error thrown when a project is not found in the database.
 * This error should NOT trigger retry logic in queue consumers.
 */
export class ProjectNotFoundError extends Error {
    public readonly projectId: string

    constructor(projectId: string) {
        super(`Project not found: ${projectId}`)
        this.name = 'ProjectNotFoundError'
        this.projectId = projectId
    }
}

/**
 * Check if an error is a non-retryable error (should not be requeued)
 */
export function isNonRetryableError(error: unknown): boolean {
    return error instanceof MemoNotFoundError || error instanceof ProjectNotFoundError
}
