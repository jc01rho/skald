import { buildFilterConditions, MemoFilter } from '../lib/filterUtils'

const tagsFilter = (operator: 'in' | 'not_in', value: string[]): MemoFilter => ({
    field: 'tags',
    operator,
    value,
    filter_type: 'native_field',
})

describe('buildFilterConditions tag filters', () => {
    it('excludes a memo when any forbidden tag exists', () => {
        const result = buildFilterConditions([tagsFilter('not_in', ['private', 'draft'])])

        expect(result.whereConditions).toEqual([
            expect.stringContaining('NOT EXISTS ('),
        ])
        expect(result.whereConditions[0]).toContain('skald_memotag.tag = ANY(?::text[])')
        expect(result.whereConditions[0]).not.toContain('!= ALL')
        expect(result.params).toEqual([['private', 'draft']])
    })

    it('uses NOT EXISTS for an empty forbidden tag list', () => {
        const result = buildFilterConditions([tagsFilter('not_in', [])])

        expect(result.whereConditions).toHaveLength(1)
        expect(result.whereConditions[0]).toContain('NOT EXISTS (')
        expect(result.whereConditions[0]).toContain('skald_memotag.tag = ANY(?::text[])')
        expect(result.params).toEqual([[]])
    })

    it('makes an empty included tag list match nothing', () => {
        expect(buildFilterConditions([tagsFilter('in', [])])).toEqual({
            whereConditions: ['FALSE'],
            params: [],
        })
    })
})
