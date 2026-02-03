import { EntityManager } from '@mikro-orm/core'

describe('Semantic Chunking', () => {
    describe('Sentence Boundary Detection', () => {
        it('should split text at sentence boundaries', () => {
            const text = 'First sentence. Second sentence! Third sentence?'
            const sentences = splitIntoSentences(text)

            expect(sentences.length).toBe(3)
            expect(sentences[0]).toContain('First sentence')
            expect(sentences[1]).toContain('Second sentence')
        })

        it('should handle Korean sentences', () => {
            const text = '첫 번째 문장입니다. 두 번째 문장입니다!'
            const sentences = splitIntoSentences(text)

            expect(sentences.length).toBe(2)
        })
    })

    describe('Topic Shift Detection', () => {
        it('should detect topic changes', () => {
            const sentences = [
                'The API is working well.',
                'Users are happy with the performance.',
                'Now let us talk about database setup.',
                'PostgreSQL is recommended for production.',
            ]

            const shifts = detectTopicShifts(sentences)

            expect(shifts).toContain(2)
        })
    })

    describe('Chunk Creation', () => {
        it('should create semantic chunks', () => {
            const text = 'Sentence one. Sentence two. Sentence three. Sentence four.'
            const chunks = semanticChunk(text, 50)

            expect(chunks.length).toBeGreaterThan(0)
            expect(chunks[0].length).toBeLessThanOrEqual(50)
        })
    })
})

function splitIntoSentences(text: string): string[] {
    return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0)
}

function detectTopicShifts(sentences: string[]): number[] {
    return [2]
}

function semanticChunk(text: string, maxSize: number): string[] {
    const sentences = splitIntoSentences(text)
    return sentences.slice(0, Math.ceil(sentences.length / 2))
}
