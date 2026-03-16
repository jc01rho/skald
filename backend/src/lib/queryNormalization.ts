const METRIC_ALIAS_PATTERN = /매트릭스?|메트릭스?/giu
const LEGACY_PATTERN = /레거시/iu

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
    const mentionsProperty = lowerNormalized.includes('property')
    const mentionsSparrowProperties = lowerNormalized.includes('sparrow.properties')
    const mentionsOptionLike =
        lowerNormalized.includes('option') || lowerNormalized.includes('옵션') || lowerNormalized.includes('설정')

    if (mentionsMetric && !mentionsSparrowProperties) {
        variants.push(`${normalized} sparrow.properties`)
    }

    if (mentionsMetric && !mentionsProperty) {
        variants.push(`${normalized} property sparrow.properties`)
    }

    if (mentionsMetric && mentionsSast && LEGACY_PATTERN.test(query)) {
        variants.push(`${normalized} legacy sparrow.properties option property`)
        variants.push(`${normalized} legacy metric enable option sparrow.properties`)
    }

    if (mentionsMetric && mentionsSast) {
        variants.push(`${normalized} 메트릭 property 설정`)

        if (!mentionsOptionLike) {
            variants.push(`${normalized} metric option property setting`)
        }
    }

    return unique(variants)
}
