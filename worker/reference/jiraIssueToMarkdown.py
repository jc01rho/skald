"""
jiraIssueToMarkdown.py - Jira 이슈를 Skald API에 적합한 형식으로 변환

Skald Memo API 형식:
- title: 이슈 요약
- content: 마크다운 형식의 전체 내용
- metadata: 필터링에 사용할 메타데이터
- tags: 검색 및 분류를 위한 태그
- reference_id: Jira 이슈 키
"""

# langchain_ollama 및 관련 모듈 임포트 제거됨
import re
import time
from datetime import datetime

# LLM 설정 (요약 생성용) - 제거됨


def jiraIssueToMarkdown(jiraIssue, customFieldDict, userIdNameDict, useSummarizationLLM=True):
    """
    Jira 이슈를 Skald API에 적합한 형식으로 변환합니다.
    
    Args:
        jiraIssue: Jira 이슈 객체
        customFieldDict: 커스텀 필드 딕셔너리
        userIdNameDict: 사용자 ID-이름 매핑 딕셔너리
        useSummarizationLLM: AI 요약 사용 여부
    
    Returns:
        dict: Skald Memo API에 적합한 형식
            - title: str
            - content: str (마크다운)
            - metadata: dict
            - tags: list
            - reference_id: str
    """
    
    function_start_time = time.time()
    print(f"[jiraIssueToMarkdown] Starting processing for {jiraIssue.key}")

    # Step 1: 기본 정보 수집
    issue = {
        "key": jiraIssue.key,
        "summary": jiraIssue.fields.summary,
        "status": jiraIssue.fields.status.name,
        "assignee": jiraIssue.fields.assignee.displayName if jiraIssue.fields.assignee else "없음",
        "reporter": jiraIssue.fields.reporter.displayName if jiraIssue.fields.reporter else "없음",
        "created": jiraIssue.fields.created,
        "updated": jiraIssue.fields.updated,
        "fixVersions": [fixVersion.name for fixVersion in jiraIssue.fields.fixVersions] if hasattr(jiraIssue.fields, "fixVersions") else [],
        "firstAssignee": None,
        "comments": [
            "From. " + comment.author.displayName + " :  " + comment.body 
            for comment in jiraIssue.fields.comment.comments
            if "이 댓글은 자동생성되었습니다." not in comment.body
            and "####Teamcity Build Link" not in comment.body
            and comment.author.displayName != "QA ROBOT"
        ]
    }

    # Step 2: 최초 담당자 찾기
    if jiraIssue is not None and hasattr(jiraIssue, 'changelog') and jiraIssue.changelog is not None:
        for history in jiraIssue.changelog.histories:
            for item in history.items:
                if item.field == 'assignee':
                    if item.fromString is not None:
                        issue["firstAssignee"] = item.fromString
                    else:
                        issue["firstAssignee"] = item.toString
                    break
            if issue["firstAssignee"] is not None:
                break
    
    if issue["firstAssignee"] is None:
        issue["firstAssignee"] = issue["assignee"]

    # Step 3: 코멘트에서 사용자 멘션 처리
    for idx, comment in enumerate(issue["comments"]):
        captured = re.findall(r'(\[~[-_\.\w]+\])', comment)
        captured1 = re.findall(r'(\[[-_\.\w]+\])', comment)
        
        comment2 = comment
        for match in captured:
            user_id = match[2:-1]
            if user_id in userIdNameDict:
                comment2 = comment2.replace(match, "To. " + userIdNameDict[user_id]) + " "
        
        comment3 = comment2
        for match in captured1:
            user_id = match[1:-1]
            if user_id in userIdNameDict:
                comment3 = comment3.replace(match, "To. " + userIdNameDict[user_id]) + " "
        
        issue["comments"][idx] = comment3

    # Step 4: 커스텀 필드 처리
    custom_field_names = ["기대 결과", "실제 결과", "재현 절차", "결함 심각도", "영향", "원인", "사이트", "구성 요소", "목표", "배경", "상세", "설명", "대상 도구"]
    for custom_field in jiraIssue.fields.__dict__.items():
        if custom_field[0].startswith("customfield_"):
            field_value = jiraIssue.fields.__dict__[custom_field[0]]
            if field_value is None:
                continue
            field_name = customFieldDict.get(custom_field[0], "")
            if field_name in custom_field_names:
                issue[field_name] = field_value

    # Step 5: 날짜 파싱
    created = datetime.strptime(jiraIssue.fields.created, "%Y-%m-%dT%H:%M:%S.%f%z")
    updated = datetime.strptime(jiraIssue.fields.updated, "%Y-%m-%dT%H:%M:%S.%f%z")

    # Step 6: 대상 도구 값 추출
    target_tool_raw = issue.get("대상 도구", "없음")
    if isinstance(target_tool_raw, list) and len(target_tool_raw) > 0:
        target_tool = target_tool_raw[0].value if hasattr(target_tool_raw[0], 'value') else str(target_tool_raw[0])
    else:
        target_tool = str(target_tool_raw) if target_tool_raw else "없음"

    # Step 7: 변경 이력 생성
    changelog_lines = []
    try:
        if jiraIssue is not None and hasattr(jiraIssue, 'changelog') and jiraIssue.changelog is not None:
            for history in jiraIssue.changelog.histories:
                created_at = getattr(history, 'created', '')
                author_name = getattr(getattr(history, 'author', None), 'displayName', '') if hasattr(history, 'author') else ''
                for item in history.items:
                    field = getattr(item, 'field', '')
                    from_str = getattr(item, 'fromString', '')
                    to_str = getattr(item, 'toString', '')
                    changelog_lines.append(f"- {created_at} {author_name} {field}: '{from_str}' -> '{to_str}'")
    except Exception:
        pass
    changelog_text = "\n".join(changelog_lines[-10:]) if changelog_lines else ""  # 최근 10개만

    # Step 8: RAG 최적화된 마크다운 콘텐츠 생성
    # 핵심 원칙: 자연어 문장 사용, 핵심 정보 앞배치, "없음" 값 제거
    
    lines = []
    
    # 제목과 핵심 요약 (가장 중요)
    lines.append(f"# {jiraIssue.key}: {jiraIssue.fields.summary}")
    lines.append("")
    

    lines.append(f"**현재 상태**: {jiraIssue.fields.status.name}, 담당자: {issue['assignee']}")
    lines.append("")
    
    # 설명 (핵심 컨텐츠)
    description = jiraIssue.fields.description if hasattr(jiraIssue.fields, "description") and jiraIssue.fields.description else ""
    if description and description.strip():
        lines.append("## 문제 설명")
        lines.append(description.strip())
        lines.append("")
    
    # 재현 절차 - 있는 경우만
    repro = issue.get("재현 절차", "")
    if repro and repro != "없음" and str(repro).strip():
        lines.append("## 재현 절차")
        lines.append(str(repro).strip())
        lines.append("")
    
    # 기대 결과와 실제 결과를 함께 (비교가 중요)
    expected = issue.get("기대 결과", "")
    actual = issue.get("실제 결과", "")
    if (expected and expected != "없음") or (actual and actual != "없음"):
        lines.append("## 결과 비교")
        if expected and expected != "없음":
            lines.append(f"**기대 결과**: {expected}")
        if actual and actual != "없음":
            lines.append(f"**실제 결과**: {actual}")
        lines.append("")
    
    # 원인 분석 - 있는 경우만
    cause = issue.get("원인", "")
    if cause and cause != "없음" and str(cause).strip():
        lines.append("## 원인")
        lines.append(str(cause).strip())
        lines.append("")
    
    # 영향 - 있는 경우만
    impact = issue.get("영향", "")
    if impact and impact != "없음" and str(impact).strip():
        lines.append("## 영향")
        lines.append(str(impact).strip())
        lines.append("")
    
    # 목표/배경/상세 - 있는 경우만
    for field_name, section_name in [("목표", "목표"), ("배경", "배경"), ("상세", "상세 내용")]:
        field_value = issue.get(field_name, "")
        if field_value and field_value != "없음" and str(field_value).strip():
            lines.append(f"## {section_name}")
            lines.append(str(field_value).strip())
            lines.append("")
    
    # 코멘트 (중요한 맥락 제공) - 최근 5개만
    if issue["comments"]:
        lines.append("## 논의 내용")
        recent_comments = issue["comments"][-5:]  # 최근 5개만
        for comment in recent_comments:
            clean_comment = comment.strip()
            if len(clean_comment) > 500:
                clean_comment = clean_comment[:500] + "..."
            lines.append(clean_comment)
            lines.append("")
    
    # 분류 정보 (검색 컨텍스트)
    classification_parts = []
    if target_tool and target_tool != "없음":
        classification_parts.append(f"도구: {target_tool}")
    site = issue.get("사이트", "")
    if site and site != "없음":
        classification_parts.append(f"사이트: {site}")
    component = issue.get("구성 요소", "")
    if component and component != "없음":
        classification_parts.append(f"구성요소: {component}")
    severity = issue.get("결함 심각도", "")
    if severity and severity != "없음":
        classification_parts.append(f"심각도: {severity}")
    if issue["fixVersions"]:
        classification_parts.append(f"수정 버전: {', '.join(issue['fixVersions'])}")
    
    if classification_parts:
        lines.append("## 분류")
        lines.append(", ".join(classification_parts) + ".")
        lines.append("")
    
    markdown_content = "\n".join(lines)

    # Step 10: AI 요약 생성 (제거됨) - 사용자 요청으로 비활성화
    clean_content = markdown_content.replace("\r\n", "\n").replace("^", "").replace("\u00A0", " ").replace("\xa0", " ").replace("~", "")
    clean_content = re.sub(r'!\w+-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}\.\w+\|width=\d+,height=\d+!', '', clean_content)
    clean_content = re.sub(r'!\w+-\d+\.\w+\|thumbnail!', '', clean_content)
    clean_content = re.sub(r'\[https?://[^\]]+\]', '', clean_content)
    clean_content = re.sub(r'\{code:java\}.*?\{code\}', '', clean_content, flags=re.DOTALL)
    clean_content = re.sub(r'\[링크\|https?://[^\]]+\]', '', clean_content)
    clean_content = re.sub(r'!\w+-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}\.\w+!', '', clean_content)
    clean_content = re.sub(r'(at\s+[\w\.$_\/]+\(.*?\)\n)+', '', clean_content)
    clean_content = re.sub(r'\n{3,}', '\n\n', clean_content)

    # Step 11: Skald 메타데이터 생성 (필터링에 사용)
    metadata = {
        # 기본 식별 정보
        "issueKey": jiraIssue.key,
        "documentType": "jira",
        "issueType": jiraIssue.fields.issuetype.name,
        "project": jiraIssue.fields.project.key,
        "projectName": jiraIssue.fields.project.name,
        
        # 담당자 정보
        "reporter": issue["reporter"],
        "assignee": issue["assignee"],
        "firstAssignee": issue["firstAssignee"],
        
        # 상태 정보
        "status": jiraIssue.fields.status.name,
        
        # 분류 정보
        "site": str(issue.get("사이트", "없음")),
        "component": str(issue.get("구성 요소", "없음")),
        "targetTool": target_tool,
        "severity": str(issue.get("결함 심각도", "없음")),
        
        # 날짜 정보 (Skald 필터에서 사용 가능)
        "createdDate": created.strftime("%Y-%m-%d"),
        "updatedDate": updated.strftime("%Y-%m-%d"),
        "createdYear": created.year,
        "createdMonth": created.month,
        "updatedYear": updated.year,
        "updatedMonth": updated.month,
        
        # 버전 정보
        "fixVersions": ", ".join(issue["fixVersions"]) if issue["fixVersions"] else "없음",
        
        # AI 요약 (제거됨)
    }

    # Step 12: 태그 생성 (Skald 검색 및 분류용)
    tags = [
        jiraIssue.fields.issuetype.name,  # 이슈 타입
        jiraIssue.fields.status.name,     # 상태
        jiraIssue.fields.project.key,     # 프로젝트 키
    ]
    
    # 대상 도구 태그
    if target_tool and target_tool != "없음":
        tags.append(target_tool)
    
    # 사이트 태그
    site = issue.get("사이트", "")
    if site and site != "없음":
        tags.append(str(site))
    
    # 중복 제거
    tags = list(dict.fromkeys(tags))

    elapsed_time = time.time() - function_start_time
    print(f"[jiraIssueToMarkdown] Completed processing for {jiraIssue.key} in {elapsed_time:.2f}s")

    # Skald Memo API 형식으로 반환
    return {
        "title": f"{jiraIssue.key} {jiraIssue.fields.summary}",
        "content": clean_content,
        "metadata": metadata,
        "tags": tags,
        "reference_id": jiraIssue.key,
        "url": f"https://jira.sparrowfasoo.com/browse/{jiraIssue.key}",
    }


def jiraIssueToDocument(jiraIssue, customFieldDict, userIdNameDict, useSummarizationLLM=True):
    """
    (호환성 유지) 기존 LangChain Document 형식으로 반환
    다른 시스템과의 호환성을 위해 유지
    """
    from langchain_core.documents import Document
    from langchain_text_splitters import RecursiveCharacterTextSplitter
    
    # Skald 형식으로 변환
    skald_data = jiraIssueToMarkdown(jiraIssue, customFieldDict, userIdNameDict, useSummarizationLLM)
    
    # 텍스트 분할
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=768,
        chunk_overlap=128,
        length_function=len,
        add_start_index=True,
        separators=["\n\n", " ", ""]
    )
    
    # 메타데이터 변환 (기존 형식 호환)
    base_metadata = {
        "source": skald_data["url"],
        "ID": skald_data["reference_id"],
        "jira": skald_data["reference_id"],
        "summary": skald_data["title"],
        "category": "jira",
        "document_type": "jira",
        **skald_data["metadata"]
    }
    
    # 청크 분할 및 Document 생성
    text_chunks = text_splitter.split_text(skald_data["content"])
    return_docs = []
    
    for i, text in enumerate(text_chunks):
        doc = Document(
            page_content=text,
            metadata={
                "chunk": i,
                "docId": f"{skald_data['reference_id']}_{i}",
                "text": skald_data["content"],
                **base_metadata
            },
            id=f"{skald_data['reference_id']}_{i}"
        )
        return_docs.append(doc)
    
    return return_docs


def GetMetaData():
    """Skald 필터링에 사용 가능한 메타데이터 필드 정보"""
    return [
        {"name": "issueType", "description": "이슈 타입 (인시던트, 장애 등)", "type": "string"},
        {"name": "project", "description": "프로젝트 키", "type": "string"},
        {"name": "status", "description": "이슈 상태", "type": "string"},
        {"name": "reporter", "description": "리포터", "type": "string"},
        {"name": "assignee", "description": "담당자", "type": "string"},
        {"name": "firstAssignee", "description": "최초 담당자", "type": "string"},
        {"name": "site", "description": "사이트/고객", "type": "string"},
        {"name": "component", "description": "구성 요소", "type": "string"},
        {"name": "targetTool", "description": "대상 도구 (SAST, DAST, SCA 등)", "type": "string"},
        {"name": "severity", "description": "결함 심각도", "type": "string"},
        {"name": "createdDate", "description": "생성일 (YYYY-MM-DD)", "type": "string"},
        {"name": "updatedDate", "description": "수정일 (YYYY-MM-DD)", "type": "string"},
        {"name": "fixVersions", "description": "고정 버전", "type": "string"},
    ]
