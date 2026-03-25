const METRIC_ALIAS_PATTERN = /매트릭스?|메트릭스?/giu
const LEGACY_PATTERN = /레거시/iu
const ENTERPRISE_ALIAS_PATTERN = /(엔터프라이즈|엔터|enterprise)/iu
const ERROR_CODE_ALIAS_PATTERN = /(에러코드|오류코드|error\s*codes?)/iu
const KOREAN_DEFINITION_PATTERN =
    /(?:^|\s)(.+?)(?:이라는|라는|이란|란)?\s*(?:기능)?\s*(?:이 뭐야\??|가 뭐야\??|뭐야\??|무엇(?:인가요|이야|인가)?\??|설명해줘\??|자세히 설명해줘\??|소개해줘\??)$/iu
const KOREAN_DEFINITION_SUFFIX_PATTERN = /(정의|개요|목적|동작 방식|사용 방법|설명)/iu

function unique(values: string[]): string[] {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

function extractDefinitionSubject(query: string): string | null {
    const normalizedQuery = normalizeWhitespace(query)
    const match = normalizedQuery.match(KOREAN_DEFINITION_PATTERN)
    if (!match?.[1]) {
        return null
    }

    const subject = normalizeWhitespace(match[1])
        .replace(/^(이|그|저)\s+/u, '')
        .replace(/\s*(기능|기능에 대해)$/u, '')
        .trim()

    return subject.length > 0 ? subject : null
}

function buildDefinitionVariants(query: string): string[] {
    const subject = extractDefinitionSubject(query)
    if (!subject) {
        return []
    }

    const normalizedQuery = normalizeWhitespace(query)
    const variants: string[] = []
    const alreadyContainsDefinitionSuffix = KOREAN_DEFINITION_SUFFIX_PATTERN.test(normalizedQuery)

    variants.push(`${subject} 기능 정의 개요 목적 동작 방식`)
    variants.push(`${subject} 기능 설명 사용 방법`)

    if (!alreadyContainsDefinitionSuffix) {
        variants.push(`${subject} 정의`)
    }

    return variants
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
    const mentionsEnterprise = ENTERPRISE_ALIAS_PATTERN.test(normalized)
    const mentionsErrorCode = ERROR_CODE_ALIAS_PATTERN.test(normalized)
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

    if (mentionsEnterprise && mentionsErrorCode) {
        variants.push('enterprise error codes')
        variants.push('sparrow enterprise error codes')
        variants.push('sparrow enterprise backend error codes')
        variants.push('backend error codes')
        variants.push('sparrow-enterprise-backend-error-codes')
        variants.push(`${normalized} enterprise error codes`)
        variants.push(`${normalized} sparrow enterprise error codes`)
        variants.push(`${normalized} sparrow enterprise backend error codes`)
        variants.push(`${normalized} backend error codes`)
        variants.push(`${normalized} sparrow-enterprise-backend-error-codes`)
    }

    variants.push(...buildDefinitionVariants(normalized))

    return unique(variants)
}
