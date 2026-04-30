const UNEXPECTED_CJK_SCRIPT_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

const CHINESE_TERM_REPLACEMENTS: Array<[RegExp, string]> = [
    [/产品开发计划/g, '제품 개발 계획'],
    [/内部文档/g, '내부 문서'],
    [/等功能切替/g, '등 기능 전환'],
    [/功能和/g, '기능 및'],
    [/功能群里/g, '기능군에는'],
    [/特殊情况/g, '특수 상황'],
    [/不安全/g, '안전하지 않은'],
    [/的平台企业与联动与否/g, '플랫폼 엔터프라이즈와 연동 여부'],
    [/备忘录的原始来源信息及元数据摘要/g, '메모의 원본 소스 정보 및 메타데이터 요약'],
    [/如果存在访问密钥验证成功的记录，则显示为/g, '액세스 키 검증 성공 기록이 있으면'],
    [/持ち、/g, '가지며, '],
    [/持ち/g, '가짐'],
    [/存在する/g, '존재하는'],
    [/となる/g, '가 되는'],
    [/に表示/g, '에 표시'],
    [/時に/g, '시 '],
    [/的功能/g, '기능'],
    [/不同的/g, '서로 다른'],
    [/最高/g, '최고'],
    [/末尾/g, '끝부분'],
    [/複数/g, '여러'],
    [/类型的/g, '타입의'],
    [/执行检索/g, '검색 실행'],
    [/展开/g, '펼침'],
    [/展開/g, '펼침'],
    [/不影响/g, '영향을 주지 않음'],
    [/名/g, '명'],
    [/导航/g, '안내'],
    [/指南/g, '가이드'],
    [/产品/g, '제품'],
    [/开发/g, '개발'],
    [/发布/g, '릴리즈'],
    [/计划/g, '계획'],
    [/规格/g, '명세'],
    [/概念/g, '개념'],
    [/流程/g, '프로세스'],
    [/策略/g, '정책'],
    [/文档/g, '문서'],
    [/资料/g, '자료'],
    [/材料/g, '자료'],
    [/命令行/g, '명령줄'],
    [/触发/g, '트리거'],
    [/停止/g, '중지'],
    [/等级/g, '등급'],
    [/入口/g, '진입점'],
    [/需要/g, '검토 필요'],
]

interface WikiNodeLike {
    canonicalName: string
    displayName: string
    description?: string
}

interface WikiClaimLike {
    claimText: string
    nodeCanonicalName?: string | null
}

interface WikiEdgeLike {
    fromCanonicalName: string
    toCanonicalName: string
}

interface WikiPageLike {
    title: string
    summary?: string
    bodyMarkdown: string
    canonical?: string | null
    claims?: WikiClaimLike[]
    nodes?: WikiNodeLike[]
    edges?: WikiEdgeLike[]
}

interface WikiCompileOutputLike {
    pages: WikiPageLike[]
    notes?: string[]
}

const normalizeWhitespace = (value: string) =>
    value
        .replace(/별안내/g, '별 안내')
        .replace(/별가이드/g, '별 가이드')
        .replace(/제품개발계획/g, '제품 개발 계획')
        .replace(/내부문서/g, '내부 문서')
        .replace(/기능切替/g, '기능 전환')
        .replace(/기능和/g, '기능 및')
        .replace(/상태で/g, '상태에서')
        .replace(/할 때に/g, '할 때')
        .replace(/경우に/g, '경우')
        .replace(/입력时才검색 실행/g, '입력 시에만 검색 실행')
        .replace(/분류하여 개수를 나타내는 메트릭이다/g, '분류해 개수를 나타내는 메트릭이다')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([,.!?;:])/g, '$1')
        .replace(/\s+([。！？；：，、])/g, '$1')
        .trim()

export const containsUnexpectedHanScript = (value: string): boolean => UNEXPECTED_CJK_SCRIPT_REGEX.test(value)

export function hasKnownWikiLanguageContamination(value: string): boolean {
    return CHINESE_TERM_REPLACEMENTS.some(([pattern]) => {
        pattern.lastIndex = 0
        return pattern.test(value)
    })
}

export function replaceKnownWikiLanguageContamination(value: string): string {
    let sanitized = value
    for (const [pattern, replacement] of CHINESE_TERM_REPLACEMENTS) {
        sanitized = sanitized.replace(pattern, replacement)
    }

    return normalizeWhitespace(sanitized)
}

export function sanitizeGeneratedWikiKoreanText(value: string): string {
    return replaceKnownWikiLanguageContamination(value)
}

export function sanitizeWikiCompileOutput<TOutput extends WikiCompileOutputLike>(output: TOutput): TOutput {
    const pages = output.pages.map((page) => {
        const canonicalNameMap = new Map<string, string>()
        const nodes = (page.nodes || []).map((node) => {
            const sanitizedCanonicalName = replaceKnownWikiLanguageContamination(node.canonicalName)
            canonicalNameMap.set(node.canonicalName.trim().toLowerCase(), sanitizedCanonicalName)
            return {
                ...node,
                canonicalName: sanitizedCanonicalName,
                displayName: sanitizeGeneratedWikiKoreanText(node.displayName),
                description: node.description ? sanitizeGeneratedWikiKoreanText(node.description) : node.description,
            }
        })

        return {
            ...page,
            title: sanitizeGeneratedWikiKoreanText(page.title),
            summary: page.summary ? sanitizeGeneratedWikiKoreanText(page.summary) : page.summary,
            bodyMarkdown: sanitizeGeneratedWikiKoreanText(page.bodyMarkdown),
            canonical: page.canonical ? replaceKnownWikiLanguageContamination(page.canonical) : page.canonical,
            claims: (page.claims || []).map((claim) => ({
                ...claim,
                claimText: sanitizeGeneratedWikiKoreanText(claim.claimText),
                nodeCanonicalName: claim.nodeCanonicalName
                    ? canonicalNameMap.get(claim.nodeCanonicalName.trim().toLowerCase()) ||
                      replaceKnownWikiLanguageContamination(claim.nodeCanonicalName)
                    : claim.nodeCanonicalName,
            })),
            nodes,
            edges: (page.edges || []).map((edge) => ({
                ...edge,
                fromCanonicalName:
                    canonicalNameMap.get(edge.fromCanonicalName.trim().toLowerCase()) ||
                    replaceKnownWikiLanguageContamination(edge.fromCanonicalName),
                toCanonicalName:
                    canonicalNameMap.get(edge.toCanonicalName.trim().toLowerCase()) ||
                    replaceKnownWikiLanguageContamination(edge.toCanonicalName),
            })),
        }
    })

    return {
        ...output,
        pages,
        notes: output.notes?.map(sanitizeGeneratedWikiKoreanText),
    }
}
