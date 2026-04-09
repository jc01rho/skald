import { randomUUID } from 'crypto'
import { MikroORM } from '@mikro-orm/postgresql'
import { DI } from '../di'
import { createTestDatabase, clearDatabase, closeDatabase } from './testDb'
import {
    createTestMemo,
    createTestOrganization,
    createTestOrganizationMembership,
    createTestPlan,
    createTestProject,
    createTestUser,
} from './testHelpers'
import { __testables__ } from '../agents/chatAgent/ragGraph'
import { RawSourceDocument } from '../entities/RawSourceDocument'
import { RawSourceContent } from '../entities/RawSourceContent'
import { WikiPage } from '../entities/WikiPage'
import { WikiPageRevision } from '../entities/WikiPageRevision'
import { WikiPageSourceLink } from '../entities/WikiPageSourceLink'
import { WikiNode } from '../entities/WikiNode'
import { WikiEdge } from '../entities/WikiEdge'

jest.setTimeout(60000)

describe('ragGraph wiki traversal', () => {
    let orm: MikroORM

    beforeAll(async () => {
        orm = await createTestDatabase()
        DI.orm = orm
        DI.em = orm.em
    })

    afterAll(async () => {
        if (orm) {
            await closeDatabase(orm)
        }
    })

    afterEach(async () => {
        if (orm) {
            await clearDatabase(orm)
        }
    })

    it('loads related wiki pages, nodes, and edges from reranked memo evidence', async () => {
        const user = await createTestUser(orm, 'wiki-traversal@example.com', 'password123')
        await createTestPlan(orm)
        const organization = await createTestOrganization(orm, 'Wiki Traversal Org', user)
        await createTestOrganizationMembership(orm, user, organization)
        const project = await createTestProject(orm, 'Wiki Traversal Project', organization, user)
        const memo = await createTestMemo(orm, project, {
            title: 'OAuth 장애 문서',
            content: 'OAuth gateway failure analysis',
            type: 'document',
        })

        const em = orm.em.fork()
        const now = new Date()

        const rawSourceDocument = em.create(RawSourceDocument, {
            uuid: randomUUID(),
            created_at: now,
            updated_at: now,
            source_type: 'document',
            external_reference: memo.uuid,
            title: memo.title,
            description: 'memo-backed raw source',
            metadata: { memoUuid: memo.uuid },
            project,
        })
        em.persist(rawSourceDocument)

        em.persist(
            em.create(RawSourceContent, {
                uuid: randomUUID(),
                created_at: now,
                content: memo.title,
                content_hash: 'hash-1',
                content_length: memo.title.length,
                raw_source_document: rawSourceDocument,
                project,
            })
        )

        const wikiPage = em.create(WikiPage, {
            uuid: randomUUID(),
            created_at: now,
            updated_at: now,
            title: 'OAuth Gateway',
            slug: 'oauth-gateway',
            content: 'Wiki page for OAuth gateway.',
            page_type: 'concept_page',
            canonical: 'oauth_gateway',
            confidence: 0.9,
            freshness: 0.8,
            review_status: 'verified',
            source_coverage_score: 0.85,
            management_mode: 'llm',
            metadata: { sourceDocumentUuid: rawSourceDocument.uuid },
            summary: '인증 게이트웨이 동작 개요',
            revision_count: 1,
            project,
        })
        em.persist(wikiPage)

        const wikiRevision = em.create(WikiPageRevision, {
            uuid: randomUUID(),
            created_at: now,
            version: 1,
            title: wikiPage.title,
            slug: wikiPage.slug,
            content: wikiPage.content,
            page_type: wikiPage.page_type,
            canonical: wikiPage.canonical,
            confidence: wikiPage.confidence,
            freshness: wikiPage.freshness,
            review_status: wikiPage.review_status,
            source_coverage_score: wikiPage.source_coverage_score,
            management_mode: wikiPage.management_mode,
            metadata: wikiPage.metadata,
            summary: wikiPage.summary,
            change_note: 'initial compile',
            wiki_page: wikiPage,
            project,
        })
        em.persist(wikiRevision)

        em.persist(
            em.create(WikiPageSourceLink, {
                uuid: randomUUID(),
                created_at: now,
                contribution_metadata: { trigger: 'test' },
                wiki_page_revision: wikiRevision,
                raw_source_document: rawSourceDocument,
                project,
            })
        )

        const fromNode = em.create(WikiNode, {
            uuid: randomUUID(),
            created_at: now,
            updated_at: now,
            node_type: 'artifact',
            canonical_name: 'oauth_gateway',
            display_name: 'OAuth Gateway',
            description: '인증 리다이렉트를 담당하는 컴포넌트',
            metadata: {},
            confidence: 0.9,
            freshness: 0.8,
            project,
        })
        const toNode = em.create(WikiNode, {
            uuid: randomUUID(),
            created_at: now,
            updated_at: now,
            node_type: 'process',
            canonical_name: 'auth_callback',
            display_name: 'Auth Callback',
            description: '인증 콜백 처리 흐름',
            metadata: {},
            confidence: 0.8,
            freshness: 0.7,
            project,
        })
        em.persist([fromNode, toNode])

        em.persist(
            em.create(WikiEdge, {
                uuid: randomUUID(),
                created_at: now,
                updated_at: now,
                edge_type: 'depends_on',
                weight: 0.8,
                provenance_type: 'test',
                from_node: fromNode,
                to_node: toNode,
                project,
            })
        )

        await em.flush()

        const result = await __testables__.wikiTraversalNode({
            project,
            rerankedResults: [
                {
                    index: 0,
                    document: 'OAuth gateway failure analysis',
                    relevance_score: 0.91,
                    memo_uuid: memo.uuid,
                    memo_title: memo.title,
                },
            ],
        } as Parameters<typeof __testables__.wikiTraversalNode>[0])

        expect(result.wikiTraversal?.pages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    slug: 'oauth-gateway',
                    title: 'OAuth Gateway',
                    canonical: 'oauth_gateway',
                }),
            ])
        )
        expect(result.wikiTraversal?.nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    canonicalName: 'oauth_gateway',
                    displayName: 'OAuth Gateway',
                }),
                expect.objectContaining({
                    canonicalName: 'auth_callback',
                    displayName: 'Auth Callback',
                }),
            ])
        )
        expect(result.wikiTraversal?.edges).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    fromCanonicalName: 'oauth_gateway',
                    toCanonicalName: 'auth_callback',
                    edgeType: 'depends_on',
                }),
            ])
        )
    })
})
