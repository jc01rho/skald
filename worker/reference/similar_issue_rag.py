"""
similar_issue_rag.py - Skald Chat & Search API를 사용한 유사 Jira 이슈 검색 시스템

이 스크립트는 새로운 Jira 이슈에 대해 Skald Search API를 사용하여
유사한 이슈를 찾고, Chat API를 통해 분석 리포트를 생성하여 Jira 댓글로 추가합니다.
"""

import time
import logging
import requests
import urllib3
import re
from datetime import datetime, timedelta
from jira import JIRA
import jiraIssueToMarkdown

# SSL 경고 비활성화 (내부 서버용 self-signed 인증서)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# 로깅 설정
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Skald API 설정
SKALD_API_KEY = "sk_proj_53810647708a05e33cf23649e53d4aa42d3aca6b"
SKALD_BASE_URL = "https://api.skald.sparrow.local"
SKALD_PROJECT_ID = "83dabf13-0c3e-41f0-8f6b-75a817cd1e25"  # Skald 프로젝트 ID

# 기본 RAG 설정 (검색 품질 최적화)
DEFAULT_RAG_CONFIG = {
    "llm_provider": "groq",
    "query_rewrite": {
        "enabled": True
    },
    "references": {
        "enabled": True
    },
    "reranking": {
        "enabled": True,
        "top_k": 10  # reranking 후 상위 10개 사용
    },
    "vector_search": {
        "similarity_threshold": 0.3,  # 더 낮은 임계값으로 더 많은 결과 포함
        "top_k": 20  # 초기 검색 결과 수 증가
    }
}

# Jira 설정
JIRA_SERVER = "https://jira.sparrowfasoo.com"
JIRA_AUTH = ("sparrow-qa", "sparrow")


def get_skald_headers():
    """Skald API 헤더 반환"""
    return {
        "Authorization": f"Bearer {SKALD_API_KEY}",
        "Content-Type": "application/json"
    }


def search_similar_memos(query: str, limit: int = 15, filters: list = None, project_id: str = None):
    """
    Skald Search API를 사용하여 유사한 메모를 검색합니다.
    벡터 유사도 검색으로 정확한 결과를 반환합니다.
    
    Args:
        query: 검색 쿼리
        limit: 검색할 최대 결과 수 (최대 50)
        filters: 적용할 필터 목록
        project_id: Skald 프로젝트 ID
    
    Returns:
        dict: 검색 결과 (results 배열 포함)
    """
    if project_id is None:
        project_id = SKALD_PROJECT_ID
    
    payload = {
        "query": query,
        "limit": min(limit, 50),
        "project_id": project_id
    }
    
    if filters:
        payload["filters"] = filters
    
    url = f"{SKALD_BASE_URL}/api/v1/search"
    
    try:
        logger.debug(f"Search API request: {payload}")
        response = requests.post(url, headers=get_skald_headers(), json=payload, timeout=60, verify=False)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"Skald search API error: {e}")
        return {"results": []}


def chat_with_skald(query: str, system_prompt: str = None, filters: list = None, stream: bool = False,
                    project_id: str = None, rag_config: dict = None):
    """
    Skald Chat API를 사용하여 RAG 기반 질의를 수행합니다.
    WebUI API와 동일한 형식으로 호출합니다.
    
    Args:
        query: 질문 내용
        system_prompt: 채팅 에이전트 동작 가이드
        filters: 검색 컨텍스트 필터
        stream: 스트리밍 응답 활성화
        project_id: Skald 프로젝트 ID (기본값: SKALD_PROJECT_ID)
        rag_config: RAG 설정 (기본값: DEFAULT_RAG_CONFIG)
    
    Returns:
        dict: Chat API 응답
    """
    import uuid
    
    # 기본값 설정
    if project_id is None:
        project_id = SKALD_PROJECT_ID
    if rag_config is None:
        rag_config = DEFAULT_RAG_CONFIG
    
    payload = {
        "chat_id": str(uuid.uuid4()),  # 각 호출마다 새로운 chat_id 생성
        "project_id": project_id,
        "query": query,
        "stream": stream,
        "rag_config": rag_config
    }
    
    if system_prompt:
        payload["system_prompt"] = system_prompt
    
    if filters:
        payload["filters"] = filters
    
    url = f"{SKALD_BASE_URL}/api/v1/chat"
    
    try:
        logger.debug(f"Chat API request: {payload}")
        response = requests.post(url, headers=get_skald_headers(), json=payload, timeout=120, verify=False)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"Skald chat API error: {e}")
        return {"ok": False, "response": "", "error": str(e)}


def get_memo_by_reference_id(reference_id: str):
    """Skald API를 사용하여 reference_id로 메모를 조회합니다."""
    url = f"{SKALD_BASE_URL}/api/v1/memo/{reference_id}?id_type=reference_id"
    
    try:
        response = requests.get(url, headers=get_skald_headers(), timeout=30, verify=False)
        if response.status_code == 200:
            return response.json()
        return None
    except requests.exceptions.RequestException as e:
        logger.warning(f"Failed to get memo by reference_id {reference_id}: {e}")
        return None


def get_memo_by_uuid(memo_uuid: str):
    """Skald API를 사용하여 memo_uuid로 메모를 조회합니다."""
    url = f"{SKALD_BASE_URL}/api/v1/memo/{memo_uuid}"
    
    try:
        response = requests.get(url, headers=get_skald_headers(), timeout=10, verify=False)
        if response.status_code == 200:
            return response.json()
        return None
    except requests.exceptions.RequestException as e:
        logger.warning(f"Failed to get memo by uuid {memo_uuid}: {e}")
        return None


def analyze_similar_issues_with_chat(new_issue_summary: str, similar_issues: list, filters: list = None) -> str:
    """
    Chat API를 사용하여 관련 기능 명세와 문제 해결 가이드를 찾습니다.
    (유사 Jira 이슈 분석은 find_similar_issues에서 이미 수행되므로 제외)
    
    Args:
        new_issue_summary: 새 이슈 요약
        similar_issues: 유사 이슈 목록
        filters: 검색 컨텍스트 필터
    
    Returns:
        str: 분석 결과
    """
    if not similar_issues:
        return ""
    
    # 요약 길이 제한 (너무 긴 요약은 잘라냄)
    MAX_SUMMARY_LEN = 200
    truncated_summary = new_issue_summary[:MAX_SUMMARY_LEN] + "..." if len(new_issue_summary) > MAX_SUMMARY_LEN else new_issue_summary
    
    # 유사 이슈 정보 구성 (상위 3개만, 요약도 길이 제한)
    issues_info_list = []
    for issue in similar_issues[:3]:  # 상위 3개만 분석 (크기 제한)
        issue_summary = issue['summary'][:100] + "..." if len(issue['summary']) > 100 else issue['summary']
        similarity = max(0, (2 - issue['score']) / 2 * 100)
        issues_info_list.append(f"- {issue['key']}: {issue_summary} ({similarity:.0f}%)")
    
    issues_info = "\n".join(issues_info_list)
    
    # 쿼리 구성 - 더 구체적이고 명확하게
    query = f"""다음 Jira 이슈와 관련된 문서를 찾아주세요.

이슈 제목: {truncated_summary}

관련 이슈 정보:
{issues_info}

위 이슈와 관련된 문서를 찾아 다음 정보를 제공해주세요:
1. 문서 제목
2. 핵심 내용 요약 (2-3문장)
3. 이 이슈와의 관련성 설명"""

    system_prompt = """당신은 기술 문서 검색 전문가입니다.
검색된 문서에 근거해서만 답변하세요.
관련 문서가 없으면 "관련 문서를 찾을 수 없습니다"라고 답하세요.
모든 답변은 한글로 작성해주세요."""
    
    # functions와 troubleshoot만 처리 (jira는 이미 find_similar_issues에서 처리됨)
    filter_configs = [
        {
            "filter_value": "functions",
            "section_title": "## 관련 기능 명세",
            "fallback_msg": "관련 기능 명세가 없습니다.",
            "url_template": "http://spms.sparrow.local/enterprise/functions/{id}",
            "id_pattern": r'([A-Z]+-[A-Z]+-\d+)'  # 예: SVR-LOGIN-002
        },
        {
            "filter_value": "troubleshoot",
            "section_title": "## 문제 해결 가이드",
            "fallback_msg": "문제 해결 가이드가 없습니다.",
            "url_template": "http://spms.sparrow.local/enterprise/troubleshoots/{id}",
            "id_pattern": r'troubleshoots?[/\s#:-]*(\d+)|#(\d+)|(?:번호|ID)[:\s]*(\d+)'  # 숫자 ID
        }
    ]
    
    combined_results = []
    
    for config in filter_configs:
        filter_value = config["filter_value"]
        
        # 각 필터에 맞는 필터 구성 (WebUI API와 동일하게 contains 사용)
        current_filters = [
            {
                "field": "source",
                "filter_type": "native_field",
                "operator": "contains",
                "value": filter_value
            }
        ]
        
        logger.info(f"Calling Chat API with filter: {filter_value}")
        
        # chat_with_skald 호출
        result = chat_with_skald(query, system_prompt=system_prompt, filters=current_filters)
        
        # 결과 수집 - 방어적 코딩 적용
        response_text = None
        references = {}
        
        if result.get("ok"):
            response_text = result.get("response")
            references = result.get("references", {})
            
            # 응답이 비어있거나 공백만 있는 경우 처리
            if response_text is not None and not response_text.strip():
                logger.warning(f"Chat API returned empty response for filter '{filter_value}'")
                response_text = None
        
        if response_text:
            # references dict에서 memo 정보 조회
            found_docs = []
            seen_uuids = set()
            
            # references에서 memo_uuid로 원본 메모 조회
            for ref_key, ref_info in references.items():
                memo_uuid = ref_info.get("memo_uuid")
                memo_title = ref_info.get("memo_title", "")
                
                if not memo_uuid or memo_uuid in seen_uuids:
                    continue
                
                # memo_uuid로 상세 정보 조회
                memo_info = get_memo_by_uuid(memo_uuid)
                if memo_info:
                    reference_id = memo_info.get("reference_id", "")
                    memo_summary = memo_info.get("summary", "")
                    
                    # URL 생성 (filter_value에 따라 다른 URL 템플릿 사용)
                    if filter_value == "functions" and reference_id:
                        doc_url = config["url_template"].format(id=reference_id)
                        doc_id = reference_id
                    elif filter_value == "troubleshoot" and reference_id:
                        doc_url = config["url_template"].format(id=reference_id)
                        doc_id = reference_id
                    else:
                        # reference_id가 없는 경우 memo_uuid 사용
                        doc_url = f"{SKALD_BASE_URL}/memo/{memo_uuid}"
                        doc_id = memo_uuid
                    
                    found_docs.append({
                        "id": doc_id,
                        "title": memo_title or memo_info.get("title", doc_id),
                        "summary": memo_summary,
                        "url": doc_url
                    })
                    seen_uuids.add(memo_uuid)
                    logger.info(f"Found {filter_value} document from references: {doc_id} - {memo_title}")
            
            # 결과 포맷팅
            if found_docs:
                section_content = []
                for i, doc in enumerate(found_docs, 1):
                    doc_line = f"{i}. [{doc['title']}]({doc['url']})"
                    if doc.get('summary'):
                        doc_line += f"\n   - {doc['summary'][:150]}..."
                    section_content.append(doc_line)
                combined_results.append(f"{config['section_title']}\n\n" + "\n".join(section_content))
            else:
                # references에서 문서를 찾지 못한 경우, 원본 응답 사용
                logger.warning(f"No documents found in references for '{filter_value}', using raw response")
                combined_results.append(f"{config['section_title']}\n\n{response_text}")
        else:
            logger.warning(f"Chat API returned no valid response for filter '{filter_value}': {result}")
            combined_results.append(f"{config['section_title']}\n\n{config['fallback_msg']}")
    
    # 모든 결과를 결합하여 반환
    return "\n\n---\n\n".join(combined_results)


def find_similar_issues(new_issue_key: str, top_k: int = 7, use_chat_analysis: bool = True):
    """
    새로운 Jira 이슈에 대해 Skald API에서 유사한 이슈를 찾습니다.
    
    Args:
        new_issue_key: 새로 생성된 Jira 이슈 키 (예: SPARROW-1234)
        top_k: 검색할 유사 이슈 수 (기본값: 7)
        use_chat_analysis: Chat API를 사용한 분석 활성화 (기본값: True)
    
    Returns:
        dict: 유사 이슈 목록과 요약 정보
    """
    # Jira 연결
    start_time = time.time()
    jira = JIRA(server=JIRA_SERVER, basic_auth=JIRA_AUTH)
    logger.info(f"Jira connection: {time.time() - start_time:.2f}s")
    
    # 새로운 이슈 가져오기
    start_time = time.time()
    new_issue = jira.issue(new_issue_key, expand='changelog')
    logger.info(f"Fetching issue {new_issue_key}: {time.time() - start_time:.2f}s")
    
    # 필드 및 사용자 정보 수집
    fields = jira.fields()
    users = jira.search_users("@", maxResults=100)
    
    customFieldDict = {}
    userIdNameDict = {}
    
    for field in fields:
        if field['id'].startswith('customfield_'):
            customFieldDict[field['id']] = field['name']
    
    for user in users:
        userIdNameDict[user.key] = user.displayName
        userIdNameDict[user.name] = user.displayName
    
    # 새로운 이슈를 Skald 형식으로 변환
    start_time = time.time()
    memo_data = jiraIssueToMarkdown.jiraIssueToMarkdown(
        new_issue, customFieldDict, userIdNameDict
    )
    logger.info(f"Issue conversion: {time.time() - start_time:.2f}s")
    
    # 검색 쿼리 생성
    new_issue_content = memo_data.get("content", new_issue.fields.summary)
    new_issue_target_tool = memo_data.get("metadata", {}).get("targetTool", "없음")
    ai_summary = memo_data.get("metadata", {}).get("aiSummary", "")
    description = new_issue.fields.description if hasattr(new_issue.fields, "description") and new_issue.fields.description else ""
    
    # Multi-query search
    queries = []
    
    if ai_summary:
        queries.append(ai_summary)
    
    queries.append(new_issue.fields.summary)
    
    if new_issue_content and len(new_issue_content) > 100:
        queries.append(new_issue_content[:1000])
    
    if description and description != new_issue.fields.summary:
        queries.append(description[:500])
    
    queries = list(dict.fromkeys([q for q in queries if q and len(q.strip()) > 5]))
    logger.info(f"Generated {len(queries)} search queries")
    
    # 검색 필터 설정
    jira_filters = [
        {
            "field": "source",
            "operator": "eq",
            "value": "jira",
            "filter_type": "native_field"
        }
    ]
    
    # targetTool 기반 필터 추가
    # if new_issue_target_tool and new_issue_target_tool != "없음":
    #     excluded_tools = []
    #     if new_issue_target_tool in ["SAST", "SAQT"]:
    #         excluded_tools = ["DAST", "SCA"]
    #     elif new_issue_target_tool == "DAST":
    #         excluded_tools = ["SAST", "SAQT", "SCA"]
    #     elif new_issue_target_tool == "SCA":
    #         excluded_tools = ["SAST", "SAQT", "DAST"]
    #
    #     for tool in excluded_tools:
    #         jira_filters.append({
    #             "field": "targetTool",
    #             "operator": "ne",
    #             "value": tool,
    #             "filter_type": "custom_metadata"
    #         })
    
    # 검색 수행 (Chat API 사용)
    all_similar_docs = []
    seen_keys = set()
    search_start_time = time.time()
    
    # Chat API를 사용한 검색 쿼리 구성
    search_query = f"""다음 Jira 이슈와 유사한 이슈들을 찾아주세요.

이슈 요약: {new_issue.fields.summary}
이슈 설명: {description[:500] if description else '없음'}

관련된 유사 이슈들의 키(예: SPARROW-1234)와 요약을 최대 {top_k * 3}개까지 나열해주세요."""
    
    system_prompt = """당신은 Jira 이슈 검색 전문가입니다.
검색된 문서에서 유사한 이슈를 찾아 다음 형식으로 답변해주세요:

1. 이슈 키 (SPARROW-1234 형식)
2. 이슈 제목
3. 유사성 설명 (1-2문장)

관련 이슈가 없으면 "유사한 이슈를 찾을 수 없습니다"라고 답하세요.
모든 답변은 한글로 작성해주세요."""
    
    logger.info(f"Using Chat API for search")
    
    # Chat API 호출
    chat_result = chat_with_skald(search_query, system_prompt=system_prompt, filters=jira_filters)
    
    # Chat API 응답에서 이슈 키와 요약 추출
    if chat_result.get("ok"):
        response_text = chat_result.get("response", "")
        logger.info(f"Chat API response received: {len(response_text)} characters")
        
        # 응답에서 이슈 키 패턴 추출 (예: SPARROW-1234, SPCN-5678)
        issue_key_pattern = r'([A-Z]+-\d+)'
        found_keys = re.findall(issue_key_pattern, response_text)
        
        # 각 이슈 키에 대해 메모 조회
        for doc_key in found_keys:
            if doc_key in seen_keys or doc_key == new_issue_key:
                continue
            
            # reference_id로 메모 조회
            memo_info = get_memo_by_reference_id(doc_key)
            if memo_info:
                memo_title = memo_info.get("title", "")
                memo_summary = memo_info.get("summary", "")
                memo_content = memo_info.get("content", "")
                
                # 거리(distance)는 Chat API에서 제공하지 않으므로 기본값 사용
                # 응답 텍스트에서 이슈 키의 위치를 기반으로 유사도 추정 (먼저 언급된 것이 더 유사)
                key_position = response_text.find(doc_key)
                distance = 1.0 - (min(key_position, 1000) / 1000) if key_position >= 0 else 1.0
                
                all_similar_docs.append({
                    "key": doc_key,
                    "title": memo_title,
                    "summary": memo_summary or memo_title,
                    "content": memo_content[:500] if memo_content else "",  # 내용 길이 제한
                    "distance": distance
                })
                seen_keys.add(doc_key)
        
        logger.info(f"Extracted {len(all_similar_docs)} issues from Chat API response")
    else:
        logger.error(f"Chat API error: {chat_result.get('error', 'Unknown error')}")
    
    # 정렬 및 필터링 (distance는 실제로 similarity - 높을수록 더 유사함)
    # similarity >= 0.575 인 것만 유지
    SIMILARITY_THRESHOLD = 0.575
    all_similar_docs = [doc for doc in all_similar_docs if doc["distance"] >= SIMILARITY_THRESHOLD]
    all_similar_docs.sort(key=lambda x: x["distance"], reverse=True)  # 내림차순 (높을수록 더 유사)
    
    logger.info(f"Search completed in {time.time() - search_start_time:.2f}s, found {len(all_similar_docs)} documents (after filtering similarity >= {SIMILARITY_THRESHOLD})")
    
    # 유사 이슈 목록 생성 (이미 필터링되었으므로 추가 임계값 체크 불필요)
    similar_issues = []
    
    for doc in all_similar_docs:
        similar_issues.append({
            "key": doc["key"],
            "summary": doc["summary"],
            "url": f"https://jira.sparrowfasoo.com/browse/{doc['key']}",
            "score": doc["distance"],
            "content": doc["content"]
        })
        
        if len(similar_issues) >= top_k:
            break
    
    logger.info(f"Returning {len(similar_issues)} similar issues")
    
    # Chat API를 사용한 분석
    chat_analysis = ""
    if use_chat_analysis and similar_issues:
        logger.info("Generating chat analysis...")
        analysis_start_time = time.time()
        chat_analysis = analyze_similar_issues_with_chat(
            new_issue.fields.summary, 
            similar_issues, 
            filters=jira_filters
        )
        logger.info(f"Chat analysis completed in {time.time() - analysis_start_time:.2f}s")
    
    return {
        "new_issue": {
            "key": new_issue.key,
            "summary": new_issue.fields.summary,
            "url": f"https://jira.sparrowfasoo.com/browse/{new_issue.key}"
        },
        "similar_issues": similar_issues,
        "chat_analysis": chat_analysis
    }


def format_similarity_comment(similar_issues: list, chat_analysis: str = "") -> str:
    """유사 이슈 목록을 Jira 댓글 형식으로 포맷팅합니다."""
    comment = "\n---\n"
    comment += "h3. 유사할 수 있는 이슈\n\n"
    
    for i, issue in enumerate(similar_issues, 1):
        similarity_percentage = max(0, (2 - issue['score']) / 2 * 100)
        comment += f"{i}. [{issue['key']}|{issue['url']}] ({similarity_percentage:.1f}%) : {issue['summary']}\n"
    
    # Chat 분석 결과 추가
    if chat_analysis:
        comment += "\n----\n"
        comment += "h4. AI 분석\n"
        comment += f"{chat_analysis}\n"
    
    comment += "\n_이 댓글은 Skald AI에 의해 자동생성되었습니다._\n"
    comment += "---\n"
    
    return comment


def post_comment_to_jira(issue_key: str, comment: str):
    """Jira 이슈에 댓글을 추가합니다."""
    jira = JIRA(server=JIRA_SERVER, basic_auth=JIRA_AUTH)
    
    try:
        jira.add_comment(issue_key, comment)
        logger.info(f"Successfully added comment to issue {issue_key}")
    except Exception as e:
        logger.error(f"Failed to add comment to issue {issue_key}: {str(e)}")


def daemon_loop(poll_interval: int = 60, lookback_minutes: int = 5,
                cache_timeout_minutes: int = 30, max_errors: int = 10,
                use_chat_analysis: bool = True):
    """
    Jira를 폴링하여 신규 이슈를 감지하고 유사 이슈를 찾아 댓글로 추가하는 데몬
    
    Args:
        poll_interval: 폴링 간격 (초)
        lookback_minutes: 조회할 과거 시간 (분)
        cache_timeout_minutes: 캐시 유효 시간 (분)
        max_errors: 최대 연속 오류 수
        use_chat_analysis: Chat API 분석 사용 여부 (기본값: True)
    """
    jira = JIRA(server=JIRA_SERVER, basic_auth=JIRA_AUTH)
    processed_issues = {}
    consecutive_errors = 0
    
    logger.info("Starting Jira polling daemon with Skald Chat & Search integration...")
    
    while True:
        try:
            logger.info("Starting new polling cycle...")
            
            since_time = datetime.now() - timedelta(minutes=lookback_minutes)
            since_time_str = since_time.strftime('%Y-%m-%d %H:%M')
            
            jql_query = f'(project = SPARROW OR project = SPCN) AND issuetype in (인시던트, 장애) AND created >= "{since_time_str}" ORDER BY created DESC'
            
            logger.info(f"Executing JQL: {jql_query}")
            issues = jira.search_issues(jql_query, maxResults=50)
            logger.info(f"Found {len(issues)} new issues since {since_time_str}")
            
            current_time = datetime.now()
            
            # 캐시 정리
            old_keys = [
                key for key, timestamp in processed_issues.items()
                if (current_time - timestamp).total_seconds() > cache_timeout_minutes * 60
            ]
            for key in old_keys:
                del processed_issues[key]
            
            logger.info(f"Cache: {len(processed_issues)} entries, removed {len(old_keys)} expired")
            
            for issue in issues:
                if issue.key in processed_issues:
                    logger.debug(f"Skipping already processed: {issue.key}")
                    continue
                
                # "(영문)" 문자열이 포함된 이슈는 건너뛰기
                if "(영문)" in issue.fields.summary:
                    logger.info(f"Skipping {issue.key}: summary contains '(영문)'")
                    processed_issues[issue.key] = current_time
                    continue
                
                # 이미 댓글이 있는지 확인
                already_processed = False
                try:
                    comments = jira.comments(issue.key)
                    for comment in comments:
                        if "이 댓글은" in comment.body and "자동생성되었습니다" in comment.body:
                            already_processed = True
                            break
                except Exception as e:
                    logger.warning(f"Could not check comments for {issue.key}: {e}")
                
                if already_processed:
                    logger.info(f"Skipping {issue.key}: already has auto-generated comment")
                    processed_issues[issue.key] = current_time
                    continue
                
                logger.info(f"Processing issue {issue.key}...")
                
                try:
                    result = find_similar_issues(issue.key, use_chat_analysis=use_chat_analysis)
                    
                    if result['similar_issues']:
                        comment = format_similarity_comment(
                            result['similar_issues'], 
                            result.get('chat_analysis', '')
                        )
                        # post_comment_to_jira(issue.key, comment)
                        logger.info(f" similar issues found for {issue.key}")
                    else:
                        logger.info(f"No similar issues found for {issue.key}")
                    
                    processed_issues[issue.key] = current_time
                    consecutive_errors = 0
                    
                except Exception as e:
                    consecutive_errors += 1
                    logger.error(f"Error processing {issue.key}: {e} (errors: {consecutive_errors})")
            
            if consecutive_errors >= max_errors:
                logger.error(f"Maximum errors reached ({max_errors}), stopping daemon")
                break
            
            logger.info(f"Polling cycle complete, sleeping {poll_interval}s...")
            time.sleep(poll_interval)
            
        except Exception as e:
            consecutive_errors += 1
            logger.error(f"Daemon loop error: {e} (errors: {consecutive_errors})")
            if consecutive_errors >= max_errors:
                logger.error(f"Maximum errors reached ({max_errors}), stopping daemon")
                break
            time.sleep(poll_interval)


if __name__ == "__main__":
    # 목업 함수 정의


    # 기존 daemon_loop 호출은 그대로 유지
    daemon_loop(poll_interval=60, lookback_minutes=9000, use_chat_analysis=True)
