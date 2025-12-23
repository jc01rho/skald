# Skald API 참고 문서

이 디렉토리는 Skald API를 사용하기 위한 참고 문서를 포함합니다.

## 목차

1. [Introduction](./introduction.md) - API 기본 개념, 인증, 응답 코드
2. [Memos](./memos.md) - 메모 CRUD API
3. [Search](./search.md) - 유사도 검색 API
4. [Chat](./chat.md) - RAG 기반 채팅 API
5. [Filters](./filters.md) - 고급 필터링 기능

## 설정

프로젝트에서 사용하는 Skald 설정:

| 항목 | 값 |
|------|-----|
| Base URL | `https://api.skald.sparrow.local` |
| API Key 환경변수 | `SKALD_API_KEY` |
| API Key 형식 | `sk_proj_xxxxxxxxx` |

## 사용 사례

이 프로젝트에서 Skald API는 다음 용도로 사용됩니다:

1. **Jira 이슈 저장**: `updateDB.py`에서 Jira 이슈를 Skald Memo로 저장
2. **유사 이슈 검색**: `similar_issue_rag.py`에서 유사한 Jira 이슈 검색
