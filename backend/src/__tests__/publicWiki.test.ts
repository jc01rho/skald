import express, { Express } from 'express'
import request from 'supertest'
import { publicWikiRouter } from '../api/publicWiki'
import { DI } from '../di'

jest.mock('../di', () => ({
    DI: {
        projects: {
            findOne: jest.fn(),
        },
        orm: {
            em: {
                fork: jest.fn(),
            },
        },
    },
}))

describe('Public Wiki API Tests', () => {
    let app: Express
    const mockFind = jest.fn()
    const mockFindProject = DI.projects.findOne as jest.Mock
    const mockFork = DI.orm.em.fork as jest.Mock

    beforeAll(() => {
        app = express()
        app.use(express.json())
        app.use('/api/public/wiki', publicWikiRouter)
    })

    beforeEach(() => {
        jest.clearAllMocks()
        mockFork.mockReturnValue({
            find: mockFind,
        })
    })

    it('lists public wiki page graph by slug', async () => {
        mockFindProject.mockResolvedValue({
            uuid: 'project-1',
            name: 'Public Wiki Project',
            chat_ui_enabled: true,
            chat_ui_slug: 'public-wiki',
            chat_ui_title: 'Public Wiki',
            chat_ui_logo_url: 'https://example.com/logo.png',
        })

        mockFind
            .mockResolvedValueOnce([
                {
                    uuid: 'page-1',
                    slug: 'architecture-overview',
                    title: 'Architecture Overview',
                    content: 'Architecture overview content',
                    page_type: 'index_page',
                    confidence: 0.91,
                    freshness: 0.85,
                    updated_at: new Date('2026-04-14T10:00:00Z'),
                },
                {
                    uuid: 'page-2',
                    slug: 'incident-flow',
                    title: 'Incident Flow',
                    content: 'Incident flow content',
                    page_type: 'process_page',
                    confidence: 0.88,
                    freshness: 0.79,
                    updated_at: new Date('2026-04-14T09:00:00Z'),
                },
            ])
            .mockResolvedValueOnce([
                {
                    uuid: 'link-1',
                    from_page: { uuid: 'page-1' },
                    to_page: { uuid: 'page-2' },
                    link_type: 'related',
                    anchor_text: 'incident flow',
                },
            ])

        const response = await request(app).get('/api/public/wiki/public-wiki/page-graph')

        expect(response.status).toBe(200)
        expect(response.body.project).toEqual({
            slug: 'public-wiki',
            name: 'Public Wiki Project',
            title: 'Public Wiki',
            logo_url: 'https://example.com/logo.png',
        })
        expect(response.body.stats).toEqual({ nodes: 2, edges: 1 })
        expect(response.body.nodes.map((node: { slug: string }) => node.slug).sort()).toEqual([
            'architecture-overview',
            'incident-flow',
        ])
        expect(response.body.edges[0]).toMatchObject({
            id: 'link-1',
            source: 'page-1',
            target: 'page-2',
            link_type: 'related',
        })
    })

    it('lists public wiki node graph by slug', async () => {
        mockFindProject.mockResolvedValue({
            uuid: 'project-2',
            name: 'Node Wiki Project',
            chat_ui_enabled: true,
            chat_ui_slug: 'public-node-wiki',
            chat_ui_title: 'Node Wiki',
            chat_ui_logo_url: null,
        })

        mockFind
            .mockResolvedValueOnce([
                {
                    uuid: 'node-1',
                    node_type: 'concept',
                    canonical_name: 'wiki-compilation',
                    display_name: 'Wiki Compilation',
                    confidence: 0.83,
                    freshness: 0.71,
                },
                {
                    uuid: 'node-2',
                    node_type: 'process',
                    canonical_name: 'refresh-enqueue',
                    display_name: 'Refresh Enqueue',
                    confidence: 0.8,
                    freshness: 0.75,
                },
            ])
            .mockResolvedValueOnce([
                {
                    uuid: 'edge-1',
                    from_node: { uuid: 'node-1' },
                    to_node: { uuid: 'node-2' },
                    edge_type: 'depends_on',
                    weight: 2,
                    provenance_type: 'llm',
                },
            ])

        const response = await request(app).get('/api/public/wiki/public-node-wiki/node-graph')

        expect(response.status).toBe(200)
        expect(response.body.project).toEqual({
            slug: 'public-node-wiki',
            name: 'Node Wiki Project',
            title: 'Node Wiki',
            logo_url: null,
        })
        expect(response.body.stats).toEqual({ nodes: 2, edges: 1 })
        expect(response.body.nodes.map((node: { display_name: string }) => node.display_name)).toEqual([
            'Wiki Compilation',
            'Refresh Enqueue',
        ])
        expect(response.body.edges[0]).toMatchObject({
            id: 'edge-1',
            source: 'node-1',
            target: 'node-2',
            edge_type: 'depends_on',
            weight: 2,
        })
    })

    it('returns availability and config for public wiki surfaces', async () => {
        mockFindProject.mockResolvedValue({
            uuid: 'project-3',
            name: 'Config Wiki Project',
            chat_ui_enabled: true,
            chat_ui_slug: 'public-config-wiki',
            chat_ui_title: 'Config Wiki',
            chat_ui_logo_url: 'https://example.com/config-logo.png',
        })

        const availabilityResponse = await request(app).get('/api/public/wiki/public-config-wiki/available')
        const configResponse = await request(app).get('/api/public/wiki/public-config-wiki/config')

        expect(availabilityResponse.status).toBe(200)
        expect(availabilityResponse.body).toEqual({ available: true })
        expect(configResponse.status).toBe(200)
        expect(configResponse.body).toEqual({
            title: 'Config Wiki',
            logo_url: 'https://example.com/config-logo.png',
        })
    })

    it('returns not found for disabled public wiki', async () => {
        mockFindProject.mockResolvedValue(null)

        const response = await request(app).get('/api/public/wiki/missing/page-graph')

        expect(response.status).toBe(404)
        expect(response.body.error).toBe('Not found')
    })
})
