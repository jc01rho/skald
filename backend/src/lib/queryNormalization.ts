const METRIC_ALIAS_PATTERN = /매트릭스?|메트릭스?/giu
const LEGACY_PATTERN = /레거시/iu
const ENTERPRISE_ALIAS_PATTERN = /(엔터프라이즈|엔터|enterprise)/iu
const ERROR_CODE_ALIAS_PATTERN = /(에러코드|오류코드|error\s*codes?)/iu
const NUMERIC_ERROR_CODE_PATTERN = /\b\d{4,}\b/gu
const KOREAN_DEFINITION_PATTERN =
    /(?:^|\s)(.+?)(?:이라는|라는|이란|란)?\s*(?:기능)?\s*(?:이 뭐야\??|가 뭐야\??|뭐야\??|무엇(?:인가요|이야|인가)?\??|설명해줘\??|자세히 설명해줘\??|소개해줘\??)$/iu
const KOREAN_DEFINITION_SUFFIX_PATTERN = /(정의|개요|목적|동작 방식|사용 방법|설명)/iu
const KOREAN_COMPARISON_PATTERN = /(.+?)(?:와|과)\s+(.+?)(?:의)?\s*(차이|비교|다른 점|뭐가 달라|어떻게 달라)/iu

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

function buildComparisonVariants(query: string): string[] {
    const normalizedQuery = normalizeWhitespace(query)
    const match = normalizedQuery.match(KOREAN_COMPARISON_PATTERN)
    if (!match?.[1] || !match?.[2]) {
        return []
    }

    const left = normalizeWhitespace(match[1])
    const right = normalizeWhitespace(match[2])
    if (!left || !right) {
        return []
    }

    return unique([
        `${left} ${right} 차이 비교`,
        `${left} ${right} 기능 설명`,
        `${left} ${right} 개요 차이점`,
        `${left} ${right} information 비교`,
    ])
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
    const mentionsLegacy = LEGACY_PATTERN.test(normalized)
    const hasNumericErrorCodes = Array.from(normalized.matchAll(NUMERIC_ERROR_CODE_PATTERN), (match) => match[0])
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

        for (const code of hasNumericErrorCodes) {
            variants.push(code)
            variants.push(`"${code}"`)
            variants.push(`enterprise error code ${code}`)
            variants.push(`sparrow enterprise error code ${code}`)
            variants.push(`backend error code ${code}`)
            variants.push(`엔터프라이즈 에러코드 ${code}`)
        }
    }

    if (mentionsSast && mentionsErrorCode) {
        variants.push('sast error codes')
        variants.push('sparrow sast error codes')
        variants.push('sparrow-sast error codes')
        variants.push('sast 오류코드')
        variants.push('sast 에러코드')
        variants.push(`${normalized} sast error codes`)

        if (mentionsLegacy) {
            variants.push('legacy sast error codes')
            variants.push('legacy sparrow sast error codes')
            variants.push('레거시 sast 오류코드')
            variants.push(`${normalized} legacy sast error codes`)
        }

        for (const code of hasNumericErrorCodes) {
            variants.push(code)
            variants.push(`"${code}"`)
            variants.push(`sast error code ${code}`)
            variants.push(`sparrow sast error code ${code}`)

            if (mentionsLegacy) {
                variants.push(`legacy sast error code ${code}`)
                variants.push(`레거시 sast 오류코드 ${code}`)
            }
        }
    }

    variants.push(...buildDefinitionVariants(normalized))
    variants.push(...buildComparisonVariants(normalized))

    return unique(variants)
}
