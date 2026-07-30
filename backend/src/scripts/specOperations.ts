import { MikroORM } from '@mikro-orm/postgresql'
import config from '@/mikro-orm.config'
import { asQueryable, parseSpecOperationArgs, runSpecOperation, type Queryable, type SpecOperation } from '@/scripts/specOperationsLib'

const NO_DATABASE: Queryable = {
    execute: async () => { throw new Error('This operation does not support database access') },
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
    let orm: MikroORM | null = null
    try {
        const options = parseSpecOperationArgs(argv)
        const databaseOperations: SpecOperation[] = ['migration-verify', 'relation-repair', 'promotion-check', 'rollout-check']
        let db = NO_DATABASE
        if (databaseOperations.includes(options.operation)) {
            orm = await MikroORM.init(config)
            db = asQueryable(orm.em.getConnection())
        }
        const output = await runSpecOperation(db, options)
        process.stdout.write(`${JSON.stringify(output)}\n`)
        return output.ok ? 0 : 1
    } catch (error) {
        process.stdout.write(`${JSON.stringify({
            schema_version: '1',
            run_id: null,
            operation: (argv[0] || null) as SpecOperation | null,
            project_scope: null,
            ok: false,
            dry_run: true,
            checks: [],
            errors: [error instanceof Error ? error.message : String(error)],
        })}\n`)
        return 1
    } finally {
        await orm?.close()
    }
}

if (require.main === module) {
    void main().then((code) => { process.exitCode = code })
}
