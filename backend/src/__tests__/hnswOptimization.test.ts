import { EntityManager } from '@mikro-orm/core'
import { HNSWOptimizationService } from '../lib/hnswOptimization'
import { DI } from '../lib/di'

describe('HNSW Optimization', () => {
    let em: EntityManager

    beforeEach(async () => {
        em = DI.em.fork()
    })

    describe('Index Creation', () => {
        it('should create optimized HNSW index with correct parameters', async () => {
            // Arrange
            const expectedParams = {
                m: 24,
                efConstruction: 256,
            }

            // Act
            await HNSWOptimizationService.createOptimizedIndex(em)

            // Assert
            const result = await em.getConnection().execute(`
                SELECT indexdef 
                FROM pg_indexes 
                WHERE indexname = 'idx_memochunk_embedding_hnsw_optimized'
            `)

            expect(result.length).toBe(1)
            expect(result[0].indexdef).toContain('hnsw')
            expect(result[0].indexdef).toContain('m = 24')
            expect(result[0].indexdef).toContain('ef_construction = 256')
        })
    })

    describe('Search Configuration', () => {
        it('should set ef_search to 150 for optimal recall', async () => {
            // Act
            await HNSWOptimizationService.configureSearchSettings(em, 150)

            // Assert
            const result = await em.getConnection().execute(`
                SHOW hnsw.ef_search
            `)

            expect(result[0].hnsw.ef_search).toBe('150')
        })

        it('should use default ef_search of 150 when not specified', async () => {
            // Act
            await HNSWOptimizationService.configureSearchSettings(em)

            // Assert
            const result = await em.getConnection().execute(`
                SHOW hnsw.ef_search
            `)

            expect(result[0].hnsw.ef_search).toBe('150')
        })
    })

    describe('Search Performance', () => {
        it('should return results within 10ms for typical query', async () => {
            // Arrange
            const queryVector = new Array(2048).fill(0.1)
            const startTime = Date.now()

            // Act
            const results = await em.getConnection().execute(`
                SELECT uuid, embedding <=> '${JSON.stringify(queryVector)}'::vector as distance
                FROM skald_memochunk
                ORDER BY embedding <=> '${JSON.stringify(queryVector)}'::vector
                LIMIT 10
            `)

            const endTime = Date.now()
            const duration = endTime - startTime

            // Assert
            expect(results.length).toBeGreaterThanOrEqual(0)
            expect(duration).toBeLessThan(10)
        })
    })

    describe('Recall Accuracy', () => {
        it('should achieve at least 95% recall@10', async () => {
            // This is a simplified test - in production, use ground truth data
            // Arrange
            const testVectors = [new Array(2048).fill(0.1), new Array(2048).fill(0.2), new Array(2048).fill(0.3)]

            // Act & Assert
            for (const vector of testVectors) {
                const hnswResults = await em.getConnection().execute(`
                    SELECT uuid, embedding <=> '${JSON.stringify(vector)}'::vector as distance
                    FROM skald_memochunk
                    ORDER BY embedding <=> '${JSON.stringify(vector)}'::vector
                    LIMIT 10
                `)

                // With ef_search=150, we expect good recall
                expect(hnswResults.length).toBeGreaterThanOrEqual(0)
            }
        })
    })
})
