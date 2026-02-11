import { logger } from '@/lib/logger'

export interface ScoringConfig {
    collectionWeightEnabled: boolean
    fileTypeWeightEnabled: boolean
    collectionWeights: Record<string, number>
    fileTypeWeights: Record<string, number>
}

/**
 * 검색 결과 가중치 서비스
 * 컬렉션(소스)과 파일 타입에 따라 검색 결과 점수에 가중치를 적용
 * OneRAG의 scoring 모듈을 참조하여 구현
 */
export class ScoringService {
    // 기본 컬렉션 가중치 (Jira 이슈는 실시간성이 높으므로 가중치 상향)
    static readonly DEFAULT_COLLECTION_WEIGHTS: Record<string, number> = {
        jira: 1.3,
        notion: 1.2,
        confluence: 1.2,
        github: 1.1,
        slack: 0.9,
        default: 1.0,
    }

    // 기본 파일 타입 가중치
    static readonly DEFAULT_FILE_TYPE_WEIGHTS: Record<string, number> = {
        pdf: 1.2,
        docx: 1.1,
        md: 1.1,
        txt: 1.0,
        html: 0.9,
        csv: 0.8,
        default: 1.0,
    }

    /**
     * 검색 결과 점수에 컬렉션/파일타입 가중치 적용
     *
     * @param score - 원본 검색 점수
     * @param collection - 컬렉션/소스 이름 (e.g., 'jira', 'notion')
     * @param fileType - 파일 타입 (e.g., 'pdf', 'md')
     * @param config - 가중치 설정 (없으면 기본값 사용)
     * @returns 가중치 적용된 점수
     */
    static applyWeight(score: number, collection?: string, fileType?: string, config?: Partial<ScoringConfig>): number {
        if (!config) return score

        let result = score

        // 컬렉션 가중치 적용
        if (config.collectionWeightEnabled && collection) {
            const weights = config.collectionWeights || this.DEFAULT_COLLECTION_WEIGHTS
            const collectionKey = collection.toLowerCase()
            const weight = weights[collectionKey] ?? weights['default'] ?? 1.0
            result *= weight
        }

        // 파일 타입 가중치 적용
        if (config.fileTypeWeightEnabled && fileType) {
            const weights = config.fileTypeWeights || this.DEFAULT_FILE_TYPE_WEIGHTS
            const fileTypeKey = fileType.toLowerCase()
            const weight = weights[fileTypeKey] ?? weights['default'] ?? 1.0
            result *= weight
        }

        if (result !== score) {
            logger.debug({ originalScore: score, adjustedScore: result, collection, fileType }, 'Score weight applied')
        }

        return result
    }

    /**
     * 여러 검색 결과에 일괄 가중치 적용
     *
     * @param results - 검색 결과 배열 [{score, collection?, fileType?, ...}]
     * @param config - 가중치 설정
     * @returns 가중치 적용된 결과 배열 (원본 수정 없이 새 배열 반환)
     */
    static applyWeights<T extends { relevance_score: number; collection?: string; fileType?: string }>(
        results: T[],
        config?: Partial<ScoringConfig>
    ): T[] {
        if (!config) return results

        return results.map((result) => ({
            ...result,
            relevance_score: this.applyWeight(result.relevance_score, result.collection, result.fileType, config),
        }))
    }

    /**
     * 기본 가중치 설정 생성
     */
    static getDefaultConfig(): ScoringConfig {
        return {
            collectionWeightEnabled: false,
            fileTypeWeightEnabled: false,
            collectionWeights: { ...this.DEFAULT_COLLECTION_WEIGHTS },
            fileTypeWeights: { ...this.DEFAULT_FILE_TYPE_WEIGHTS },
        }
    }
}
