const METRIC_ALIAS_PATTERN = /매트릭스?|메트릭스?/giu
const LEGACY_PATTERN = /레거시/giu

function unique(values: string[]): string[] {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

export function normalizeTechnicalAliases(query: string): string {
    return query.replace(METRIC_ALIAS_PATTERN, 'metric')
}

export function expandTechnicalQueryVariants(query: string): string[] {
    const normalized = normalizeTechnicalAliases(query)
    const variants: string[] = [query]

    if (normalized !== query) {
        variants.push(normalized)
    }

    const lowerNormalized = normalized.toLowerCase()
    const mentionsMetric = lowerNormalized.includes('metric')
    const mentionsSast = lowerNormalized.includes('sast')
    const mentionsProperties = lowerNormalized.includes('property') || lowerNormalized.includes('sparrow.properties')

    if (mentionsMetric && !mentionsProperties) {
        variants.push(`${normalized} property sparrow.properties`)
    }

    if (mentionsMetric && mentionsSast && LEGACY_PATTERN.test(query)) {
        variants.push(`${normalized} legacy sparrow.properties option property`)
        LEGACY_PATTERN.lastIndex = 0
    }

    if (mentionsMetric && mentionsSast) {
        variants.push(`${normalized} 메트릭 property 설정`)
    }

    return unique(variants)
}
