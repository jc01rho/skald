// Mock for @sentry/node to avoid module resolution issues in Jest
// The actual @sentry/node has internal dependencies that Jest can't resolve

export const init = jest.fn()
export const captureException = jest.fn()
export const captureMessage = jest.fn()
export const setUser = jest.fn()
export const setTag = jest.fn()
export const setExtra = jest.fn()
export const addBreadcrumb = jest.fn()
export const startSpan = jest.fn((options: any, callback: any) => callback({ setStatus: jest.fn() }))
export const withScope = jest.fn((callback: any) =>
    callback({ setTag: jest.fn(), setExtra: jest.fn(), setLevel: jest.fn() })
)
export const startTransaction = jest.fn(() => ({
    finish: jest.fn(),
    setStatus: jest.fn(),
}))
export const getCurrentHub = jest.fn(() => ({
    getScope: jest.fn(() => ({
        setTag: jest.fn(),
        setExtra: jest.fn(),
    })),
}))
export const Handlers = {
    requestHandler: jest.fn(() => (req: any, res: any, next: any) => next()),
    errorHandler: jest.fn(() => (err: any, req: any, res: any, next: any) => next(err)),
    tracingHandler: jest.fn(() => (req: any, res: any, next: any) => next()),
}

export default {
    init,
    captureException,
    captureMessage,
    setUser,
    setTag,
    setExtra,
    addBreadcrumb,
    startSpan,
    withScope,
    startTransaction,
    getCurrentHub,
    Handlers,
}
