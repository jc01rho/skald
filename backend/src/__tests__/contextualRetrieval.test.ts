import { EntityManager } from '@mikro-orm/core'
import { generateChunkContext, addContextToChunk } from '../lib/chunkProcessor'
import { LLMService } from '../services/llmService'

describe('Contextual Retrieval', () => {
    describe('Context Generation', () => {
        it('should generate context for a chunk', async () => {
            const chunk = 'The revenue grew by 3% over the previous quarter.'
            const fullDocument =
                'ACME Corp Financial Report 2023. Q1 revenue was $300M. Q2 revenue was $309M. The revenue grew by 3% over the previous quarter. Q3 projections look strong.'
            const documentTitle = 'ACME Corp Q2 2023 Report'

            const context = await generateChunkContext(chunk, fullDocument, documentTitle)

            expect(context).toBeTruthy()
            expect(context.length).toBeGreaterThan(20)
            expect(context.length).toBeLessThan(150)
        })

        it('should include document title in context', async () => {
            const chunk = 'Feature X is now available.'
            const fullDocument =
                'Product Update Notes. We have added many features. Feature X is now available. Please try it out.'
            const documentTitle = 'Product Update v2.0'

            const context = await generateChunkContext(chunk, fullDocument, documentTitle)

            expect(context.toLowerCase()).toContain('product update')
        })
    })

    describe('Chunk Processing', () => {
        it('should prepend context to chunk', async () => {
            const chunk = 'The API returns 200 status code.'
            const context = 'This is from the API documentation section about success responses.'

            const contextualized = await addContextToChunk(chunk, context)

            expect(contextualized).toContain(context)
            expect(contextualized).toContain(chunk)
            expect(contextualized.indexOf(context)).toBeLessThan(contextualized.indexOf(chunk))
        })

        it('should handle empty context gracefully', async () => {
            const chunk = 'Simple chunk content.'
            const context = ''

            const contextualized = await addContextToChunk(chunk, context)

            expect(contextualized).toBe(chunk)
        })
    })

    describe('End-to-End Retrieval', () => {
        it('should improve retrieval with context', async () => {
            const originalChunk = 'The revenue grew by 3%.'
            const contextualizedChunk =
                '[CONTEXT: From ACME Corp Q2 2023 SEC filing, previous quarter was $314M] The revenue grew by 3%.'

            // Contextualized chunk should have better embedding for queries about ACME Corp
            expect(contextualizedChunk).toContain('ACME Corp')
            expect(contextualizedChunk).toContain('Q2 2023')
        })
    })
})
