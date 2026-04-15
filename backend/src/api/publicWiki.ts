import express, { Request, Response } from 'express'
import { z } from 'zod'
import { DI } from '@/di'
import { WikiPage } from '@/entities/WikiPage'
import { WikiPageLink } from '@/entities/WikiPageLink'
import { WikiNode } from '@/entities/WikiNode'
import { WikiEdge } from '@/entities/WikiEdge'

const SlugParamsSchema = z.object({
    slug: z.string().min(1, 'Slug is required'),
})

interface PublicWikiProject {
    uuid: string
    name: string
    chat_ui_enabled: boolean
    chat_ui_slug: string | null
    chat_ui_title?: string | null
    chat_ui_logo_url?: string | null
}

const getProjectBySlug = async (slug: string) => {
    return DI.projects.findOne(
        { chat_ui_slug: slug },
        {
            fields: ['uuid', 'name', 'chat_ui_enabled', 'chat_ui_slug', 'chat_ui_title', 'chat_ui_logo_url'],
        }
    ) as Promise<PublicWikiProject | null>
}

const getPublicProject = async (req: Request, res: Response) => {
    const validatedParams = SlugParamsSchema.safeParse(req.params)
    if (!validatedParams.success) {
        res.status(400).json({ error: validatedParams.error.errors.map((err) => err.message).join(', ') })
        return null
    }

    const project = await getProjectBySlug(validatedParams.data.slug)
    if (!project || !project.chat_ui_enabled) {
        res.status(404).json({ error: 'Not found' })
        return null
    }

    return project
}

export const checkPublicWikiAvailability = async (req: Request, res: Response) => {
    const validatedParams = SlugParamsSchema.safeParse(req.params)
    if (!validatedParams.success) {
        return res.status(400).json({ error: validatedParams.error.errors.map((err) => err.message).join(', ') })
    }

    const project = await getProjectBySlug(validatedParams.data.slug)
    return res.status(200).json({ available: project?.chat_ui_enabled === true })
}

export const getPublicWikiConfig = async (req: Request, res: Response) => {
    const project = await getPublicProject(req, res)
    if (!project) {
        return
    }

    return res.status(200).json({
        title: project.chat_ui_title || project.name,
        logo_url: project.chat_ui_logo_url || null,
    })
}

export const getPublicWikiPageGraph = async (req: Request, res: Response) => {
    const project = await getPublicProject(req, res)
    if (!project) {
        return
    }

    const em = DI.orm.em.fork()
    const pages = await em.find(
        WikiPage,
        { project: project.uuid },
        {
            orderBy: { updated_at: 'DESC', created_at: 'DESC' },
        }
    )

    const pageIds = pages.map((page) => page.uuid)
    const pageLinks =
        pageIds.length > 0
            ? await em.find(
                  WikiPageLink,
                  {
                      from_page: { $in: pageIds },
                      to_page: { $in: pageIds },
                  },
                  {
                      populate: ['from_page', 'to_page'],
                  }
              )
            : []

    return res.status(200).json({
        project: {
            slug: project.chat_ui_slug,
            name: project.name,
            title: project.chat_ui_title || project.name,
            logo_url: project.chat_ui_logo_url || null,
        },
        stats: {
            nodes: pages.length,
            edges: pageLinks.length,
        },
        nodes: pages.map((page) => ({
            id: page.uuid,
            slug: page.slug,
            title: page.title,
            page_type: page.page_type,
            confidence: page.confidence,
            freshness: page.freshness,
        })),
        edges: pageLinks.map((link) => ({
            id: link.uuid,
            source: link.from_page.uuid,
            target: link.to_page.uuid,
            link_type: link.link_type,
            anchor_text: link.anchor_text || null,
        })),
    })
}

export const getPublicWikiNodeGraph = async (req: Request, res: Response) => {
    const project = await getPublicProject(req, res)
    if (!project) {
        return
    }

    const em = DI.orm.em.fork()
    const nodes = await em.find(
        WikiNode,
        { project: project.uuid },
        {
            orderBy: { display_name: 'ASC', canonical_name: 'ASC' },
        }
    )

    const nodeIds = nodes.map((node) => node.uuid)
    const edges =
        nodeIds.length > 0
            ? await em.find(
                  WikiEdge,
                  {
                      project: project.uuid,
                      from_node: { $in: nodeIds },
                      to_node: { $in: nodeIds },
                  },
                  {
                      populate: ['from_node', 'to_node'],
                      orderBy: { weight: 'DESC', created_at: 'ASC' },
                  }
              )
            : []

    return res.status(200).json({
        project: {
            slug: project.chat_ui_slug,
            name: project.name,
            title: project.chat_ui_title || project.name,
            logo_url: project.chat_ui_logo_url || null,
        },
        stats: {
            nodes: nodes.length,
            edges: edges.length,
        },
        nodes: nodes.map((node) => ({
            id: node.uuid,
            node_type: node.node_type,
            canonical_name: node.canonical_name,
            display_name: node.display_name,
            confidence: node.confidence,
            freshness: node.freshness,
        })),
        edges: edges.map((edge) => ({
            id: edge.uuid,
            source: edge.from_node.uuid,
            target: edge.to_node.uuid,
            edge_type: edge.edge_type,
            weight: edge.weight,
            provenance_type: edge.provenance_type || null,
        })),
    })
}

export const publicWikiRouter = express.Router({ mergeParams: true })
publicWikiRouter.get('/:slug/available', checkPublicWikiAvailability)
publicWikiRouter.get('/:slug/config', getPublicWikiConfig)
publicWikiRouter.get('/:slug/page-graph', getPublicWikiPageGraph)
publicWikiRouter.get('/:slug/node-graph', getPublicWikiNodeGraph)
