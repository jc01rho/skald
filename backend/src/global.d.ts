import type { RequestUser } from '@/middleware/requestUser'
import type { Project } from '@/entities/Project'

declare global {
    namespace Express {
        interface Request {
            context?: {
                requestUser?: RequestUser
                project?: Project
            }
        }
        interface Response {
            sentry?: string
        }
    }
}

export {}
