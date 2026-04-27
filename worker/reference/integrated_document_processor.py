"""
integrated_document_processor.py - Skald API 기반 통합 문서 처리기

이 모듈은 다양한 소스(Jira, SPMS API 등)에서 문서를 가져와
Skald Memo API를 통해 저장합니다.

Skald API:
- POST /api/v1/memo: 메모 생성
- PATCH /api/v1/memo/{id}?id_type=reference_id: 메모 업데이트
- DELETE /api/v1/memo/{id}?id_type=reference_id: 메모 삭제
- POST /api/v1/search: 유사 문서 검색
"""

import time
import random
import logging
import os
import requests
import urllib3
import re
from datetime import datetime
from collections import Counter
from typing import Optional, List, Dict, Any
from jira import JIRA
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
import jiraIssueToMarkdown
from document_processor_base import BaseDocumentProcessor

# SSL 경고 비활성화 (내부 서버용 self-signed 인증서)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# 로깅 설정
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Skald API 설정
SKALD_API_KEY = os.getenv("SKALD_API_KEY", "")
SKALD_BASE_URL = "https://api.skald.sparrow.local"


class IntegratedDocumentProcessor(BaseDocumentProcessor):
    """Skald API 기반 통합 문서 처리기"""
    
    def __init__(self):
        super().__init__()
        # Jira 관련 초기화
        self.jira = JIRA(server="https://jira.sparrowfasoo.com", basic_auth=("sparrow-qa", "sparrow"))
        self.fields = self.jira.fields()
        self.users = self.jira.search_users("@", maxResults=100)
        
        self.customFieldDict = {}
        self.userIdNameDict = {}
        self.current_processed_ids = None
        
        # Jira 커스텀 필드 정보 수집
        for field in self.fields:
            if field['id'].startswith('customfield_'):
                self.customFieldDict[field['id']] = field['name']
        
        # Jira 사용자 정보 수집
        for user in self.users:
            self.userIdNameDict[user.key] = user.displayName
            self.userIdNameDict[user.name] = user.displayName
        
        logger.info(f"Loaded {len(self.customFieldDict)} custom fields and {len(self.userIdNameDict)} users")
    
    # ==================== Skald API 메서드 ====================
    
    def _get_skald_headers(self):
        """Skald API 헤더 반환"""
        if not SKALD_API_KEY:
            raise RuntimeError("SKALD_API_KEY environment variable is required")
        return {
            "Authorization": f"Bearer {SKALD_API_KEY}",
            "Content-Type": "application/json"
        }
    
    def _compute_content_hash(self, memo_data: dict) -> str:
        """메모 데이터의 해시를 계산합니다."""
        import hashlib
        import json
        
        # 태그를 문자열로 변환 (dict 객체가 포함될 수 있음)
        tags = memo_data.get("tags", [])
        tags_str = []
        for tag in tags:
            if isinstance(tag, dict):
                tags_str.append(str(tag.get("value", tag.get("name", str(tag)))))
            else:
                tags_str.append(str(tag))
        
        # 해시에 포함할 필드들 (변경 감지 대상)
        hash_content = {
            "title": str(memo_data.get("title", "")),
            "content": str(memo_data.get("content", "")),
            "metadata": memo_data.get("metadata", {}),
            "tags": sorted(tags_str),
        }
        
        # JSON 직렬화 후 해시 계산
        content_str = json.dumps(hash_content, sort_keys=True, ensure_ascii=False, default=str)
        return hashlib.sha256(content_str.encode('utf-8')).hexdigest()[:16]
    
    def create_or_update_memo(self, memo_data: dict, max_retries: int = 3):
        """
        Skald API를 사용하여 메모를 생성하거나 업데이트합니다.
        변경점이 없으면 업데이트를 건너뜁니다.
        
        Args:
            memo_data: 메모 데이터
                - title: str
                - content: str
                - metadata: dict
                - tags: list
                - reference_id: str
                - source: str
            max_retries: 최대 재시도 횟수
        
        Returns:
            str: 결과 상태 ("created", "updated", "skipped", "failed")
        """
        headers = self._get_skald_headers()
        reference_id = memo_data.get("reference_id")
        
        if not reference_id:
            logger.error("reference_id is required")
            return "failed"
        
        # 새 콘텐츠 해시 계산
        new_hash = self._compute_content_hash(memo_data)
        
        # 기존 메모 존재 여부 및 해시 확인
        get_url = f"{SKALD_BASE_URL}/api/v1/memo/{reference_id}?id_type=reference_id"
        memo_exists = False
        existing_hash = None
        
        try:
            response = requests.get(get_url, headers=headers, timeout=30, verify=False)
            if response.status_code == 200:
                memo_exists = True
                existing_memo = response.json()
                
                # 기존 메모에서 해시 계산
                existing_data = {
                    "title": existing_memo.get("title", ""),
                    "content": existing_memo.get("content", ""),
                    "metadata": existing_memo.get("metadata", {}),
                    "tags": existing_memo.get("tags", []),
                }
                existing_hash = self._compute_content_hash(existing_data)
                
                # 해시가 동일하면 업데이트 건너뛰기
                if existing_hash == new_hash:
                    logger.debug(f"Skipping {reference_id}: No changes detected (hash: {new_hash})")
                    return "skipped"
                    
        except requests.exceptions.RequestException:
            pass
        
        # Skald API payload 생성
        payload = {
            "title": memo_data.get("title", ""),
            "content": memo_data.get("content", ""),
            "metadata": memo_data.get("metadata", {}),
            "reference_id": reference_id,
            "source": memo_data.get("source", "spms"),
            "tags": memo_data.get("tags", []),
        }
        
        for attempt in range(max_retries):
            try:
                if memo_exists:
                    # 기존 메모 업데이트 (PATCH)
                    patch_url = f"{SKALD_BASE_URL}/api/v1/memo/{reference_id}?id_type=reference_id"
                    response = requests.patch(patch_url, headers=headers, json=payload, timeout=60, verify=False)
                else:
                    # 새 메모 생성 (POST)
                    post_url = f"{SKALD_BASE_URL}/api/v1/memo"
                    response = requests.post(post_url, headers=headers, json=payload, timeout=60, verify=False)
                
                if response.status_code in [200, 201, 204]:
                    return "updated" if memo_exists else "created"
                else:
                    logger.warning(f"Attempt {attempt + 1} failed: Status {response.status_code}")
                    
            except requests.exceptions.RequestException as e:
                logger.warning(f"Attempt {attempt + 1} error: {e}")
            
            if attempt < max_retries - 1:
                wait_time = (2 ** attempt) + random.uniform(0, 1)
                time.sleep(wait_time)
        
        return "failed"
    
    def delete_memo(self, reference_id: str):
        """
        Skald API를 사용하여 메모를 삭제합니다.
        
        Args:
            reference_id: 참조 ID
        
        Returns:
            bool: 성공 여부
        """
        headers = self._get_skald_headers()
        delete_url = f"{SKALD_BASE_URL}/api/v1/memo/{reference_id}?id_type=reference_id"
        
        try:
            response = requests.delete(delete_url, headers=headers, timeout=30, verify=False)
            return response.status_code in [200, 204, 404]  # 404도 성공으로 처리 (이미 삭제됨)
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to delete memo {reference_id}: {e}")
            return False
    
    def search_similar_memos(self, query: str, limit: int = 15, filters: Optional[List[Dict[str, Any]]] = None):
        """
        Skald Search API를 사용하여 유사한 메모를 검색합니다.
        
        Args:
            query: 검색 쿼리
            limit: 검색할 최대 결과 수
            filters: 적용할 필터 목록
        
        Returns:
            dict: 검색 결과
        """
        headers = self._get_skald_headers()
        
        payload = {
            "query": query,
            "limit": min(limit, 50),
        }
        
        if filters:
            payload["filters"] = filters
        
        url = f"{SKALD_BASE_URL}/api/v1/search"
        
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=60, verify=False)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"Skald search API error: {e}")
            return {"results": []}
    
    def delete_all_memos(self, source: Optional[str] = None):
        """
        Skald의 메모를 삭제합니다.
        
        Args:
            source: 삭제할 메모의 source 필터 (예: "jira", "troubles")
                    None이면 모든 메모 삭제
        
        Returns:
            dict: 삭제 통계 (total, deleted, failed)
        """
        headers = self._get_skald_headers()
        search_url = f"{SKALD_BASE_URL}/api/v1/search"
        stats = {"total": 0, "deleted": 0, "failed": 0}
        all_memo_uuids = set()  # 중복 방지를 위해 set 사용
        
        try:
            # 페이지네이션으로 모든 메모 가져오기
            limit = 50  # API 제한: 최대 50
            
            # 필터 설정
            filters = []
            if source:
                filters.append({
                    "field": "source",
                    "operator": "eq",
                    "value": source,
                    "filter_type": "native_field"
                })
                logger.info(f"Deleting memos with source: {source}")
            else:
                logger.info("Deleting all memos (no source filter)")
            
            while True:
                search_payload = {
                    "query": "*",  # 와일드카드로 모든 문서 검색
                    "limit": limit
                }
                
                # 필터가 있으면 추가
                if filters:
                    search_payload["filters"] = filters
                
                # 메모 검색
                response = requests.post(search_url, headers=headers, json=search_payload, timeout=60, verify=False)
                
                # 상세 에러 정보 출력
                if response.status_code != 200:
                    logger.error(f"Search API error: {response.status_code} - {response.text}")
                    raise requests.exceptions.RequestException(f"Search API returned {response.status_code}: {response.text}")
                
                search_result = response.json()
                memos = search_result.get("results", [])
                
                if not memos:  # 더 이상 메모가 없으면 종료
                    break
                
                # 메모 UUID 수집 (set을 사용하여 중복 방지)
                for memo in memos:
                    memo_uuid = memo.get("memo_uuid")
                    if memo_uuid:
                        all_memo_uuids.add(memo_uuid)
                
                logger.info(f"Fetched {len(memos)} memos (unique total so far: {len(all_memo_uuids)})")
                
                # 가져온 메모 수가 limit보다 적으면 마지막 페이지
                if len(memos) < limit:
                    break
            
            stats["total"] = len(all_memo_uuids)
            logger.info(f"Found {stats['total']} unique memos to delete")
            
            # 각 메모 삭제
            for memo_uuid in all_memo_uuids:
                if self.delete_memo(memo_uuid):
                    stats["deleted"] += 1
                else:
                    stats["failed"] += 1
            
            logger.info(f"Delete completed: deleted={stats['deleted']}, failed={stats['failed']}")
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to fetch memos for deletion: {e}")
            stats["failed"] = stats["total"]
        
        return stats
    
    # ==================== 문서 변환 메서드 ====================
    
    def create_memo_from_api_content(self, title: str, content: str, url: str, 
                                      doc_type: str, api_data: dict) -> dict:
        """
        API 콘텐츠에서 Skald Memo 형식으로 변환합니다.
        
        Args:
            title: 문서 제목
            content: 마크다운 콘텐츠
            url: 원본 URL
            doc_type: 문서 타입 (functions, techs, information, screens)
            api_data: API 응답 데이터
        
        Returns:
            dict: Skald Memo 형식
        """
        # 날짜 형식 변환
        created_date = self._parse_date(api_data.get('date_created', ''))
        updated_date = self._parse_date(api_data.get('date_updated', ''))
        
        # 키워드 자동 추출
        words = re.findall(r'[가-힣]{2,}|[a-zA-Z]{3,}', content)
        word_freq = Counter(words)
        doc_keywords = [word for word, count in word_freq.most_common(10) if count >= 2]
        
        # 태그 생성
        tags = [doc_type, "SPARROW"]
        
        # 콘텐츠 기반 태그 추가
        content_lower = content.lower()
        tag_keywords = {
            'error': ['에러', '오류', 'error', 'exception', '실패'],
            'login': ['로그인', '인증', 'login', 'auth', '세션'],
            'ui': ['화면', 'ui', 'gui', '표시', 'display', '버튼', 'button'],
            'performance': ['성능', '느림', '지연', 'slow', 'performance'],
            'data': ['데이터', '저장', '조회', 'data', 'database', 'db'],
            'api': ['api', '인터페이스', 'rest', 'endpoint'],
            'security': ['보안', '권한', 'security', 'permission', '암호화']
        }
        
        for tag, keywords in tag_keywords.items():
            if any(kw in content_lower for kw in keywords):
                tags.append(tag)
        
        # reference_id 생성 (문서 타입 + ID)
        doc_id = api_data.get('function_id') if doc_type == "functions" else api_data.get('id', '')
        reference_id = f"{doc_type}-{doc_id}"
        
        # 메타데이터 생성
        metadata = {
            "documentType": doc_type,
            "title": title,
            "url": url,
            "createdDate": created_date,
            "updatedDate": updated_date,
            "keywords": ", ".join(doc_keywords),
            "project": "SPARROW",
            "status": api_data.get('status', 'published'),
            "apiId": str(doc_id),
        }
        
        # 문서 타입별 추가 메타데이터
        if doc_type == "troubles":
            metadata["category"] = api_data.get('category', '')
            metadata["productId"] = api_data.get('productId', '')
            metadata["internalOnly"] = str(api_data.get('internalOnly', 'false'))
        
        return {
            "title": title,
            "content": content,
            "metadata": metadata,
            "tags": list(set(tags)),  # 중복 제거
            "reference_id": reference_id,
            "source": doc_type,
        }

    def fetch_troubles_list(self, page=1, size=20):
        url = "http://192.168.101.228:5808/api/1.0/troubles"
        try:
            response = requests.post(url, json={"page": page, "size": size}, timeout=10)
            if response.status_code == 200:
                data = response.json()
                return data.get('list', [])
            return []
        except Exception as e:
            logger.error(f"Error fetching troubles list: {e}")
            return []

    def fetch_trouble_detail(self, trouble_id):
        url = f"http://192.168.101.228:5808/api/1.0/troubles/{trouble_id}"
        try:
            response = requests.post(url, timeout=10)
            if response.status_code == 200:
                return response.json()
            return None
        except Exception as e:
            logger.error(f"Error fetching trouble detail {trouble_id}: {e}")
            return None

    def create_troubles_markdown(self, data):
        lines = []
        lines.append(f"# {data.get('title', '')}")
        lines.append("")
        
        if data.get('summary'):
            lines.append("## 요약")
            lines.append(data.get('summary'))
            lines.append("")
            
        if data.get('cause'):
            lines.append("## 원인")
            lines.append(data.get('cause'))
            lines.append("")
            
        if data.get('solution'):
            lines.append("## 해결 방법")
            lines.append(data.get('solution'))
            lines.append("")

        return "\n".join(lines)

    
    # ==================== 문서 처리 메서드 ====================
    
    def process_function(self, function_id):
        """특정 Function 문서를 처리하여 Skald에 저장"""
        function_data = self.fetch_function_detail(function_id)
        if not function_data:
            return "failed"
        
        content = self.create_functions_markdown(function_data)
        title = function_data.get('name', f"Function {function_id}")
        url = f"http://spms.sparrow.local/api/functions/{function_id}"
        
        memo_data = self.create_memo_from_api_content(title, content, url, "functions", function_data)
        
        result = self.create_or_update_memo(memo_data)
        if result != "failed":
            logger.debug(f"Function {function_id}: {result}")
        return result
    
    def process_trouble(self, trouble_id):
        """특정 Trouble 문서를 처리하여 Skald에 저장"""
        trouble_data = self.fetch_trouble_detail(trouble_id)
        if not trouble_data:
            return "failed"
        
        content = self.create_troubles_markdown(trouble_data)
        title = trouble_data.get('title', f"Trouble {trouble_id}")
        # URL for troubles? Assumed based on other patterns or just use API URL if no frontend URL known.
        # User didn't provide frontend URL. I will use the API detail URL or a placeholder. 
        # Actually SPMS usually has a pattern. I'll use a placeholder or the API URL.
        # Let's use the list URL with anchor for now or just generic.
        url = f"http://192.168.101.228:5808/troubles/{trouble_id}" # Guessing frontend URL
        
        # Helper method uses general api_data. convert some fields if necessary
        # create_memo_from_api_content parses date from 'date_created'.
        # Trouble API has 'created' (timestamp int).
        # I need to handle this in create_memo_from_api_content or sanitize here.
        
        # Convert timestamps to ISO string for consistency if needed, 
        # but create_memo_from_api_content calls _parse_date which might expect specific format.
        # Let's check _parse_date (it's in Base, I can't see it). 
        # But 'created' is int (ms).
        created_ts = trouble_data.get('created')
        updated_ts = trouble_data.get('updated')
        
        if created_ts:
            trouble_data['date_created'] = datetime.fromtimestamp(created_ts / 1000).isoformat()
        if updated_ts:
            trouble_data['date_updated'] = datetime.fromtimestamp(updated_ts / 1000).isoformat()
            
        memo_data = self.create_memo_from_api_content(title, content, url, "troubles", trouble_data)
        
        result = self.create_or_update_memo(memo_data)
        if result != "failed":
            logger.debug(f"Trouble {trouble_id}: {result}")
        return result
    
    # ==================== 배치 처리 메서드 ====================
    
    def process_all_functions(self, max_pages=5, max_workers=3):
        """
        모든 Functions 문서를 처리하여 Skald에 저장합니다.
        이미 존재하는 문서는 내용이 변경되었을 때만 업데이트합니다.
        
        Args:
            max_pages: 처리할 최대 페이지 수
            max_workers: 병렬 처리 워커 수
        
        Returns:
            dict: 처리 통계 (created, updated, skipped, failed)
        """
        stats = {"created": 0, "updated": 0, "skipped": 0, "failed": 0}
        seen_ids = set()  # 중복된 아이템 ID를 필터링하기 위한 집합
        
        for page in range(1, max_pages + 1):
            functions_list = self.fetch_functions_list(page=page, size=20)
            if not functions_list:
                break
            
            # 중복된 ID 필터링
            unique_functions = []
            for item in functions_list:
                item_id = item.get('function_id')
                if item_id and item_id not in seen_ids:
                    seen_ids.add(item_id)
                    unique_functions.append(item)
            
            # 필터링된 항목 수 로깅
            if len(unique_functions) < len(functions_list):
                logger.info(f"Filtered {len(functions_list) - len(unique_functions)} duplicate items from page {page}")
            
            # 항목 미리보기 로깅
            items_preview = []
            for i, item in enumerate(unique_functions[:5]):
                item_id = item.get('function_id', 'N/A')
                item_name = item.get('name', 'N/A')
                items_preview.append(f"[{item_id}] {item_name}")
            
            preview_str = ", ".join(items_preview)
            if len(unique_functions) > 5:
                preview_str += ", ..."
            
            logger.info(f"Processing functions page {page} ({len(unique_functions)} unique items): {preview_str}")
            
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {
                    executor.submit(self.process_function, item.get('function_id')): item.get('function_id')
                    for item in unique_functions if item.get('function_id')
                }
                
                for future in as_completed(futures):
                    function_id = futures[future]
                    try:
                        result = future.result()
                        if result in stats:
                            stats[result] += 1
                    except Exception as e:
                        logger.error(f"Error processing function {function_id}: {e}")
                        stats["failed"] += 1
        
        logger.info(f"Functions: created={stats['created']}, updated={stats['updated']}, skipped={stats['skipped']}, failed={stats['failed']}")
        return stats
    
    def process_all_troubles(self, max_pages=5, max_workers=3):
        """모든 Troubles 문서를 처리하여 Skald에 저장"""
        stats = {"created": 0, "updated": 0, "skipped": 0, "failed": 0}
        seen_ids = set()  # 중복된 아이템 ID를 필터링하기 위한 집합
        
        for page in range(1, max_pages + 1):
            troubles_list = self.fetch_troubles_list(page=page, size=20)
            if not troubles_list:
                break
            
            # 중복된 ID 필터링
            unique_troubles = []
            for item in troubles_list:
                item_id = item.get('id')
                if item_id and item_id not in seen_ids:
                    seen_ids.add(item_id)
                    unique_troubles.append(item)
            
            # 필터링된 항목 수 로깅
            if len(unique_troubles) < len(troubles_list):
                logger.info(f"Filtered {len(troubles_list) - len(unique_troubles)} duplicate items from page {page}")
            
            # unique_troubles의 첫 5개 항목에 대한 id와 제목을 포함하여 로그 메시지 개선
            items_preview = []
            for i, item in enumerate(unique_troubles[:5]):
                item_id = item.get('id', 'N/A')
                item_title = item.get('title', 'N/A')
                items_preview.append(f"[{item_id}] {item_title}")
            
            preview_str = ", ".join(items_preview)
            if len(unique_troubles) > 5:
                preview_str += ", ..."
            
            logger.info(f"Processing troubles page {page} ({len(unique_troubles)} unique items): {preview_str}")
            
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {
                    executor.submit(self.process_trouble, item.get('id')): item.get('id')
                    for item in unique_troubles if item.get('id')
                }
                
                for future in as_completed(futures):
                    trouble_id = futures[future]
                    try:
                        result = future.result()
                        if result in stats:
                            stats[result] += 1
                    except Exception as e:
                        logger.error(f"Error processing trouble {trouble_id}: {e}")
                        stats["failed"] += 1
        
        logger.info(f"Troubles: created={stats['created']}, updated={stats['updated']}, skipped={stats['skipped']}, failed={stats['failed']}")
        return stats
    
    # ==================== Jira 이슈 처리 ====================
    
    def _process_single_jira_issue(self, issue):
        """개별 Jira 이슈를 처리하여 Skald에 저장"""
        try:
            # jiraIssueToMarkdown을 사용하여 Skald 형식으로 변환
            memo_data = jiraIssueToMarkdown.jiraIssueToMarkdown(
                issue, 
                self.customFieldDict, 
                self.userIdNameDict
            )
            
            if not memo_data or not memo_data.get("content"):
                return {"status": "failed", "issue_key": issue.key, "error": "No content generated"}
            
            # source를 jira로 설정
            memo_data["source"] = "jira"
            
            # Skald API로 저장
            result = self.create_or_update_memo(memo_data)
            return {"status": result, "issue_key": issue.key}
                
        except Exception as e:
            logger.error(f"Error processing Jira issue {issue.key}: {e}")
            return {"status": "failed", "issue_key": issue.key, "error": str(e)}

    def process_jira_issues(self, jql_query: str = "TYPE IN (인시던트, 장애) ORDER BY updated DESC",
                           max_results: int = 50, max_workers: int = 3, max_batches: Optional[int] = None):
        """
        Jira 이슈를 처리하여 Skald에 저장합니다.
        
        Args:
            jql_query: JQL 쿼리
            max_results: 한 번에 가져올 최대 이슈 수 (기본값: 50)
            max_workers: 병렬 처리 워커 수
            max_batches: 최대 처리할 배치 수 (None이면 모든 배치 처리)
        
        Returns:
            dict: 처리 통계 (created, updated, skipped, failed, total_processed, total_issues)
        """
        stats = {"created": 0, "updated": 0, "skipped": 0, "failed": 0, "total_processed": 0, "total_issues": 0}
        start_at = 0
        batch_num = 0
        total_issues_found = 0
        
        logger.info(f"Starting Jira issues processing with JQL: {jql_query}")
        logger.info(f"Configuration: max_results={max_results}, max_workers={max_workers}, max_batches={max_batches}")
        
        while True:
            # 최대 배치 수 확인
            if max_batches is not None and batch_num >= max_batches:
                logger.info(f"Reached maximum batch limit: {max_batches}")
                break
            
            batch_num += 1
            logger.info(f"Fetching batch {batch_num}: issues {start_at} to {start_at + max_results - 1}")
            
            try:
                # 첫 번째 배치에서는 total_issues_found를 설정
                issues = self.jira.search_issues(
                    jql_query,
                    startAt=start_at,
                    maxResults=max_results,
                    validate_query=True
                )
                
                if not issues:
                    logger.info("No more issues found")
                    break
                
                # 첫 번째 배치에서 total_issues_found 설정
                if batch_num == 1 and hasattr(issues, 'total'):
                    total_issues_found = issues.total
                    stats["total_issues"] = total_issues_found
                    logger.info(f"Total issues found: {total_issues_found}")
                
                logger.info(f"Retrieved {len(issues)} issues in batch {batch_num}")
                
                # 배치 처리
                with ThreadPoolExecutor(max_workers=max_workers) as executor:
                    futures = {
                        executor.submit(self._process_single_jira_issue, issue): issue.key
                        for issue in issues
                    }
                    
                    batch_stats = {"created": 0, "updated": 0, "skipped": 0, "failed": 0}
                    
                    for future in as_completed(futures):
                        issue_key = futures[future]
                        try:
                            result = future.result()
                            status = result.get("status", "failed")
                            if status in batch_stats:
                                batch_stats[status] += 1
                                stats[status] += 1
                                stats["total_processed"] += 1
                            
                        except Exception as e:
                            batch_stats["failed"] += 1
                            stats["failed"] += 1
                            stats["total_processed"] += 1
                            logger.error(f"Error processing {issue_key}: {e}")
                    
                    # 배치별 통계 로깅
                    logger.info(f"Batch {batch_num} completed: created={batch_stats['created']}, "
                               f"updated={batch_stats['updated']}, skipped={batch_stats['skipped']}, failed={batch_stats['failed']}")
                    
                    # 전체 진행 상황 로깅
                    total_processed = stats["total_processed"]
                    if total_processed % 50 == 0 or total_processed == total_issues_found:
                        progress_percent = (total_processed / total_issues_found * 100) if total_issues_found > 0 else 0
                        logger.info(f"Overall progress: {total_processed}/{total_issues_found} ({progress_percent:.1f}%) - "
                                   f"created={stats['created']}, updated={stats['updated']}, skipped={stats['skipped']}, failed={stats['failed']}")
                
                start_at += max_results
                
                # 마지막 배치 확인
                if len(issues) < max_results:
                    logger.info("Reached end of results")
                    break
                
                # API 레이트 리밋 방지를 위한 짧은 대기
                time.sleep(0.5)
                
            except Exception as e:
                logger.error(f"Error fetching batch {batch_num}: {e}")
                stats["failed"] += max_results  # 추정치
                stats["total_processed"] += max_results  # 추정치
                break
        
        logger.info(f"Jira processing completed: created={stats['created']}, updated={stats['updated']}, "
                   f"skipped={stats['skipped']}, failed={stats['failed']}, total_processed={stats['total_processed']}")
        return stats
    
    # ==================== 검색 메서드 ====================
    
    def search_related_documents(self, query: str, doc_types: Optional[List[str]] = None, limit: int = 10):
        """
        Skald API를 사용하여 관련 문서를 검색합니다.
        
        Args:
            query: 검색 쿼리
            doc_types: 문서 타입 필터 (예: ["jira", "functions"])
            limit: 검색할 최대 결과 수
        
        Returns:
            dict: 검색 결과
        """
        filters = []
        
        if doc_types:
            # source 필터 추가
            for doc_type in doc_types:
                filters.append({
                    "field": "source",
                    "operator": "eq",
                    "value": doc_type,
                    "filter_type": "native_field"
                })
        
        search_result = self.search_similar_memos(query, limit=limit, filters=filters if filters else None)
        
        # 결과 포맷팅
        formatted_results = {
            "jira_results": [],
            "api_results": []
        }
        
        for result in search_result.get("results", []):
            memo_title = result.get("memo_title", "")
            chunk_content = result.get("chunk_content", "")
            distance = result.get("distance", 1.0)
            
            # 유사도 점수로 변환
            similarity = max(0, (2 - distance) / 2 * 100)
            
            result_item = {
                "title": memo_title,
                "content": chunk_content[:200] + "..." if len(chunk_content) > 200 else chunk_content,
                "similarity": f"{similarity:.1f}%",
                "distance": distance
            }
            
            # Jira 이슈 키 패턴 확인
            if re.search(r'[A-Z]+-\d+', memo_title):
                formatted_results["jira_results"].append(result_item)
            else:
                formatted_results["api_results"].append(result_item)
        
        return formatted_results


# ==================== 메인 실행 ====================

if __name__ == "__main__":




    processor = IntegratedDocumentProcessor()
    

    # Jira 이슈 문서 처리
    logger.info("\n--- Jira 이슈 문서 처리 ---")
    jql_query = 'TYPE IN (인시던트, 장애) AND updated >= -10d ORDER BY updated DESC'
    # jql_query = 'TYPE IN (인시던트, 장애) ORDER BY updated DESC'
    jira_stats = processor.process_jira_issues(
        jql_query=jql_query,
        max_results=50,
        max_workers=3
    )
    
    logger.info(f"\nJira 이슈 처리 완료: created={jira_stats['created']}, updated={jira_stats['updated']}, skipped={jira_stats['skipped']}, failed={jira_stats['failed']}")
    
    # 주말(토요일 또는 일요일)에만 API 문서 처리 실행
    current_day = datetime.now().weekday()
    
    if current_day <= 5:  # 5(토요일) 또는 6(일요일)
        logger.info("주말입니다. API 문서 처리를 시작합니다...")
        
        # Functions API 문서 처리
        logger.info("\n--- Functions API 문서 처리 ---")
        func_count = processor.process_all_functions(max_pages=200)
        
        # Troubles API 문서 처리
        logger.info("\n--- Troubles API 문서 처리 ---")
        troubles_count = processor.process_all_troubles(max_pages=200, max_workers=3)
        
        logger.info(f"\nAPI 문서 처리 완료: Functions={func_count}, Troubles={troubles_count}")
    else:
        logger.info("평일입니다. API 문서 처리를 건너뜁니다.")
    

    
    # 검색 테스트
    logger.info("\n--- 검색 기능 테스트 ---")
    search_result = processor.search_related_documents("보안 취약점 분석", limit=5)
    logger.info(f"검색 결과: Jira={len(search_result['jira_results'])}, API={len(search_result['api_results'])}")
    
    logger.info("\n" + "=" * 50)
    logger.info("문서 처리 완료!")
    logger.info("=" * 50)
