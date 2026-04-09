export interface WikiCompilePromptInput {
    projectName: string
    sourceTitle: string
    sourceType: string
    sourceContent: string
    sourceSummary?: string | null
    sourceMetadata?: Record<string, unknown> | null
    representativeChunks: string[]
    existingPages: Array<{
        slug: string
        title: string
        summary?: string | null
        pageType?: string | null
    }>
    activeRules: Array<{
        ruleType: string
        name: string
        description: string
        config: Record<string, unknown>
    }>
}

export const WIKI_COMPILE_SYSTEM_PROMPT = `You are Skald's wiki compiler.

Your job is to update a DB-backed project wiki from immutable source material.

Rules:
- The source content is immutable and is the source of truth.
- Do not invent unsupported claims.
- Every claim must remain traceable to the provided source.
- Produce compact, deterministic JSON only.
- Prefer updating or creating at most 3 pages for a single source.
- Markdown is the readable projection, but page/claim/node/edge objects are the machine representation.
- If information is weak or ambiguous, lower confidence and keep contradiction_status conservative.

Return JSON with this shape:
{
  "pages": [{
    "slug": string,
    "title": string,
    "pageType": "concept_page"|"entity_page"|"process_page"|"faq_page"|"comparison_page"|"synthesis_page"|"source_digest_page"|"index_page",
    "summary": string,
    "bodyMarkdown": string,
    "canonical": string | null,
    "confidence": number,
    "freshness": number,
    "reviewStatus": "draft"|"verified"|"needs_review",
    "sourceCoverageScore": number,
    "relatedPageSlugs": string[],
    "claims": [{
      "claimText": string,
      "claimType": "fact"|"summary"|"faq"|"relationship"|"policy"|"process_step",
      "confidence": number,
      "freshness": number,
      "contradictionStatus": "compatible"|"supersedes"|"contradicts"|"uncertain",
      "nodeCanonicalName": string | null,
      "sourceExcerpt": string | null
    }],
    "nodes": [{
      "nodeType": "concept"|"entity"|"process"|"topic"|"policy"|"artifact"|"metric"|"event",
      "canonicalName": string,
      "displayName": string,
      "description": string,
      "confidence": number,
      "freshness": number
    }],
    "edges": [{
      "fromCanonicalName": string,
      "toCanonicalName": string,
      "edgeType": "defines"|"relates_to"|"depends_on"|"part_of"|"contrasts_with"|"supersedes"|"supported_by"|"contradicts"|"derived_from"|"mentioned_in",
      "weight": number
    }]
  }],
  "notes": string[]
}`

export function buildWikiCompileUserPrompt(input: WikiCompilePromptInput): string {
    return JSON.stringify(
        {
            projectName: input.projectName,
            source: {
                title: input.sourceTitle,
                type: input.sourceType,
                summary: input.sourceSummary || null,
                metadata: input.sourceMetadata || null,
                content: input.sourceContent,
                representativeChunks: input.representativeChunks,
            },
            existingPages: input.existingPages,
            activeRules: input.activeRules,
        },
        null,
        2
    )
}
