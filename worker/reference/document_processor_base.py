from datetime import datetime
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
import requests


class BaseDocumentProcessor:
    """Base class containing common functionality for document processing"""
    
    def __init__(self):
        # 검색 정확도 향상을 위한 최적화된 텍스트 분할 설정
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=768,
            chunk_overlap=256,  # 128 → 256: 더 많은 컨텍스트 보존으로 경계 정보 손실 방지
            length_function=len,
            add_start_index=True,
            # 한글 문장 경계를 존중하는 separator 추가 (우선순위 높음)
            separators=[
                "\n\n",      # 단락 구분
                "\n",        # 줄바꿈
                ". ",        # 영어 문장 종결
                "。",        # 한글 문장 종결 (온점)
                "! ",        # 느낌표
                "? ",        # 물음표
                "; ",        # 세미콜론
                ", ",        # 쉼표
                " ",         # 공백
                ""           # 문자 단위 (최후)
            ]
        )
    
    def _parse_date(self, date_str):
        """날짜 문자열을 파싱하여 YYYY-MM-DD 형식으로 반환"""
        if not date_str:
            return ""
        try:
            # ISO 형식 날짜 파싱
            dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
            return dt.strftime('%Y-%m-%d')
        except:
            return date_str

    def fetch_functions_list(self, page=1, size=20):
        """Functions API에서 기능 목록을 가져오는 함수"""
        url = f"http://spms.sparrow.local/api/functions?status=completed&product=enterprise&page={page}&size={size}"
        try:
            response = requests.get(url)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print(f"Error fetching functions list: {e}")
            return []

    def fetch_techs_list(self, page=1, size=20):
        """Techs API에서 기술 문서 목록을 가져오는 함수"""
        url = f"http://spms.sparrow.local/api/techs?page={page}&size={size}"
        try:
            response = requests.get(url)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print(f"Error fetching techs list: {e}")
            return []

    def fetch_information_list(self, page=1, size=20):
        """Information API에서 정보 목록을 가져오는 함수"""
        url = f"http://spms.sparrow.local/api/information?status=completed&product=enterprise&page={page}&size={size}"
        try:
            response = requests.get(url)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print(f"Error fetching information list: {e}")
            return []

    def fetch_screens_list(self, page=1, size=20):
        """Screens API에서 화면 목록을 가져오는 함수"""
        url = f"http://spms.sparrow.local/api/screens?product=enterprise&page={page}&size={size}"
        try:
            response = requests.get(url)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print(f"Error fetching screens list: {e}")
            return []

    def fetch_function_detail(self, function_id):
        """특정 기능의 상세 정보를 가져오는 함수"""
        url = f"http://spms.sparrow.local/api/functions/{function_id}"
        try:
            response = requests.get(url)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print(f"Error fetching function detail {function_id}: {e}")
            return {}

    def fetch_tech_detail(self, tech_id):
        """특정 기술 문서의 상세 정보를 가져오는 함수"""
        url = f"http://spms.sparrow.local/api/techs/{tech_id}"
        try:
            response = requests.get(url)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print(f"Error fetching tech detail {tech_id}: {e}")
            return {}

    def fetch_information_detail(self, info_id):
        """특정 정보 문서의 상세 정보를 가져오는 함수"""
        url = f"http://spms.sparrow.local/api/information/{info_id}"
        try:
            response = requests.get(url)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print(f"Error fetching information detail {info_id}: {e}")
            return {}

    def fetch_screen_detail(self, screen_id):
        """특정 화면 문서의 상세 정보를 가져오는 함수"""
        url = f"http://spms.sparrow.local/api/screens/{screen_id}"
        try:
            response = requests.get(url)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print(f"Error fetching screen detail {screen_id}: {e}")
            return {}

    def create_functions_markdown(self, function_data):
        """Functions API 데이터를 RAG에 최적화된 마크다운 형식으로 변환"""
        if not function_data:
            return ""

        # 날짜 형식 변환
        created_date = self._parse_date(function_data.get('date_created', ''))
        updated_date = self._parse_date(function_data.get('date_updated', ''))
        
        name = function_data.get('name', 'Unknown Function')
        detail = function_data.get('detail', '')
        category = function_data.get('category', '')
        component = function_data.get('component', '')
        function_id = function_data.get('function_id', '')
        
        # 핵심 요약을 자연어 문장으로 작성 (RAG에서 가장 중요한 부분)
        summary_parts = [f"'{name}'"]
        if component:
            summary_parts.append(f" 기능은 {component} 구성 요소에 속합니다")
        if category:
            summary_parts.append(f" (카테고리: {category})")
        summary = "".join(summary_parts) + "."
        
        # 마크다운 시작 - 핵심 정보를 앞에 배치
        lines = [
            f"# {name}",
            "",
        ]
        
        # 상세 설명 (가장 중요한 컨텐츠)
        if detail and detail.strip():
            lines.extend([
                "## 기능 설명",
                detail.strip(),
                "",
            ])
        
        # 동작 목록을 자연어로
        actions = function_data.get('actions', [])
        if actions:
            action_descriptions = []
            for action in actions:
                action_id = action.get('action_id', {}) or {}
                action_name = action_id.get('name', '')
                action_desc = action_id.get('description', '')
                if action_name and action_desc:
                    action_descriptions.append(f"- **{action_name}**: {action_desc}")
                elif action_name:
                    action_descriptions.append(f"- {action_name}")
            
            if action_descriptions:
                lines.extend([
                    "## 지원하는 동작",
                    f"이 기능은 다음과 같은 동작을 지원합니다:",
                    "",
                    *action_descriptions,
                    "",
                ])
        
        # 관련 정보를 자연어로
        related_info = function_data.get('related_info', [])
        if related_info:
            info_names = [info.get('Information_Definition_id', {}).get('Name', '') for info in related_info if info.get('Information_Definition_id')]
            info_names = [n for n in info_names if n]
            if info_names:
                lines.extend([
                    "## 관련 정보",
                    f"이 기능과 관련된 정보: {', '.join(info_names)}.",
                    "",
                ])
        
        # 관련 기능
        related_functions = function_data.get('relatedFunctions', [])
        if related_functions:
            func_names = [f"{func.get('name', 'Unknown')}" for func in related_functions if func.get('name')]
            if func_names:
                lines.extend([
                    "## 관련 기능",
                    f"연관된 기능: {', '.join(func_names)}.",
                    "",
                ])
        
        # 하위 기능
        children = function_data.get('children', [])
        if children:
            child_names = [f"{child.get('name', 'Unknown')}" for child in children if child.get('name')]
            if child_names:
                lines.extend([
                    "## 하위 기능",
                    f"이 기능의 하위 기능: {', '.join(child_names)}.",
                    "",
                ])
        
        # JIRA 이슈 정보
        jira_issues = function_data.get('jira_issues', [])
        if jira_issues:
            issue_keys = [issue.get('id', '') for issue in jira_issues if issue.get('id')]
            if issue_keys:
                lines.extend([
                    "## 관련 이슈",
                    f"관련된 JIRA 이슈: {', '.join(issue_keys)}.",
                    "",
                ])
        
        # 분류 정보 (검색에 도움되는 컨텍스트)
        context_parts = []
        if component:
            context_parts.append(f"구성 요소: {component}")
        if category:
            context_parts.append(f"카테고리: {category}")
        if function_data.get('version'):
            context_parts.append(f"버전: {function_data.get('version')}")
        if updated_date:
            context_parts.append(f"최종 수정: {updated_date}")
        
        if context_parts:
            lines.extend([
                "## 분류",
                ", ".join(context_parts) + ".",
                "",
            ])

        return "\n".join(lines).strip()

    def create_techs_markdown(self, tech_data):
        """Techs API 데이터를 RAG에 최적화된 마크다운 형식으로 변환"""
        if not tech_data:
            return ""

        # 날짜 형식 변환
        updated_date = self._parse_date(tech_data.get('date_updated', ''))
        
        title = tech_data.get('title', 'Unknown Tech Document')
        description = tech_data.get('description', '')
        product_id = tech_data.get('product_id', '')
        version = tech_data.get('version', '')
        
        # 핵심 요약을 자연어 문장으로
        summary_parts = [f"'{title}'"]
        if product_id:
            summary_parts.append(f" 문서는 {product_id} 제품에 대한 기술 문서입니다")
        summary = "".join(summary_parts) + "."
        
        # 마크다운 시작
        lines = [
            f"# {title}",
            "",
        ]
        
        # 설명 (핵심 컨텐츠)
        if description and description.strip():
            lines.extend([
                "## 내용",
                description.strip(),
                "",
            ])
        
        # 관련 링크
        link = tech_data.get('link', '')
        if link:
            lines.extend([
                "## 관련 자료",
                f"추가 정보는 다음 링크에서 확인할 수 있습니다: {link}",
                "",
            ])
        
        # 분류 정보
        context_parts = []
        if product_id:
            context_parts.append(f"제품: {product_id}")
        if version:
            context_parts.append(f"버전: {version}")
        if tech_data.get('status'):
            context_parts.append(f"상태: {tech_data.get('status')}")
        if updated_date:
            context_parts.append(f"최종 수정: {updated_date}")
        
        if context_parts:
            lines.extend([
                "## 분류",
                ", ".join(context_parts) + ".",
                "",
            ])

        return "\n".join(lines).strip()

    def create_document_from_api_content(self, title, content, url, doc_type, api_data):
        """API 콘텐츠에서 LangChain Document 생성"""
        # 날짜 형식 변환
        created_date = self._parse_date(api_data.get('date_created', ''))
        updated_date = self._parse_date(api_data.get('date_updated', ''))

        # 메타데이터 생성
        metadata = {
            "source": url,
            "document_type": doc_type,
            "category": doc_type,
            "title": title,
            "name": api_data.get('name', ''),  # name 필드 추가 (information과 screens 문서용)
            "url": url,
            "created_date": created_date,
            "updated_date": updated_date,
            "tags": ["SPARROW", doc_type],
            "project": "SPARROW",
            "content_type": "function_spec" if doc_type == "functions" else "technical_guide",
            "status": api_data.get('status', 'published'),
            "author": "system",
            "text": content,
            "api_id": str(api_data.get('id', '')),
            "api_function_id": str(api_data.get('function_id', '')) if doc_type == "functions" else str(api_data.get('id', '')),
            "component": api_data.get('component', '') if doc_type == "functions" else "",
            "version": api_data.get('version', ''),
            "product_id": api_data.get('product_id', '') if doc_type == "techs" else api_data.get('product', {}).get('product_id', ''),
        }

        # 텍스트 분할
        text_chunks = self.text_splitter.split_text(content)
        documents = []

        for i, text in enumerate(text_chunks):
            doc = Document(
                page_content=text,
                metadata={
                    "chunk": i,
                    "docId": f"{doc_type}_{api_data.get('id', 'unknown')}_{i}",
                    **metadata
                },
                id=f"{doc_type}_{api_data.get('id', 'unknown')}_{i}"
            )
            documents.append(doc)

        return documents

    def process_function(self, function_id):
        """특정 기능을 처리하는 함수"""
        function_data = self.fetch_function_detail(function_id)
        if not function_data:
            return []

        content = self.create_functions_markdown(function_data)
        title = function_data.get('name', f"Function {function_id}")
        url = f"http://spms.sparrow.local/api/functions/{function_id}"

        return self.create_document_from_api_content(title, content, url, "functions", function_data)

    def process_tech(self, tech_id):
        """특정 기술 문서를 처리하는 함수"""
        tech_data = self.fetch_tech_detail(tech_id)
        if not tech_data:
            return []

        content = self.create_techs_markdown(tech_data)
        title = tech_data.get('title', f"Tech {tech_id}")
        url = f"http://spms.sparrow.local/api/techs/{tech_id}"

        return self.create_document_from_api_content(title, content, url, "techs", tech_data)

    def process_all_functions(self, max_pages=5):
        """모든 Functions 문서를 처리하는 함수"""
        all_documents = []

        for page in range(1, max_pages + 1):
            functions_list = self.fetch_functions_list(page=page, size=20)
            if not functions_list:
                break

            for function in functions_list:
                function_id = function.get('function_id')
                if function_id:
                    docs = self.process_function(function_id)
                    all_documents.extend(docs)

        return all_documents

    def process_all_techs(self, max_pages=5):
        """모든 Techs 문서를 처리하는 함수"""
        all_documents = []

        for page in range(1, max_pages + 1):
            techs_list = self.fetch_techs_list(page=page, size=20)
            if not techs_list:
                break

            for tech in techs_list:
                tech_id = tech.get('id')
                if tech_id:
                    docs = self.process_tech(tech_id)
                    all_documents.extend(docs)

        return all_documents

    def create_information_markdown(self, info_data):
        """Information API 데이터를 RAG에 최적화된 마크다운 형식으로 변환"""
        if not info_data:
            return ""

        # 날짜 형식 변환
        updated_date = self._parse_date(info_data.get('date_updated', ''))

        # 제품 정보 추출
        product_id = self._extract_product_id(info_data.get('product'))
        product_name = self._extract_product_name(info_data.get('product'))

        # 제목 추출
        title = info_data.get('Name', info_data.get('name', info_data.get('title', 'Unknown Information')))
        description = info_data.get('description', '')
        
        # 핵심 요약을 자연어 문장으로
        summary_parts = [f"'{title}'"]
        if product_name:
            summary_parts.append(f" 문서는 {product_name} 제품에 대한 정보를 제공합니다")
        summary = "".join(summary_parts) + "."
        
        # 마크다운 시작
        lines = [
            f"# {title}",
            "",
        ]
        
        # 설명 (핵심 컨텐츠)
        if description and description.strip():
            lines.extend([
                "## 내용",
                description.strip(),
                "",
            ])
        
        # 관련 링크
        link = info_data.get('link', '')
        if link:
            lines.extend([
                "## 참고 자료",
                f"추가 정보: {link}",
                "",
            ])
        
        # 분류 정보
        context_parts = []
        if product_name:
            context_parts.append(f"제품: {product_name}")
        if updated_date:
            context_parts.append(f"최종 수정: {updated_date}")
        
        if context_parts:
            lines.extend([
                "## 분류",
                ", ".join(context_parts) + ".",
                "",
            ])

        return "\n".join(lines).strip()

    def _extract_product_id(self, product_data):
        """다양한 형태의 product 데이터에서 ID 추출"""
        if isinstance(product_data, dict):
            return product_data.get('product_id', '')
        elif isinstance(product_data, str):
            return product_data
        elif isinstance(product_data, list):
            # 기존 product_id 체크 후 Product_Info_product_id도 체크
            product_ids = []
            for p in product_data:
                if isinstance(p, dict):
                    # product_id 우선, 없으면 Product_Info_product_id 사용
                    product_id = p.get('product_id') or p.get('Product_Info_product_id', '')
                    if product_id:
                        product_ids.append(product_id)
                else:
                    product_ids.append(str(p))
            return ', '.join(product_ids) if product_ids else ''
        else:
            return ''

    def _extract_product_name(self, product_data):
        """product 객체에서 product_name을 추출"""
        if isinstance(product_data, dict):
            return product_data.get('product_name', '')
        elif isinstance(product_data, str):
            return product_data
        elif isinstance(product_data, list):
            names = []
            for p in product_data:
                if isinstance(p, dict):
                    name = p.get('product_name', '')
                    if name:
                        names.append(name)
                else:
                    names.append(str(p))
            return ', '.join(names) if names else ''
        else:
            return ''

    def create_screens_markdown(self, screen_data):
        """Screens API 데이터를 RAG에 최적화된 마크다운 형식으로 변환"""
        if not screen_data:
            return ""

        # 날짜 형식 변환
        updated_date = self._parse_date(screen_data.get('date_updated', ''))

        # 제품 정보 추출
        product_id = self._extract_product_id(screen_data.get('product'))
        product_name = self._extract_product_name(screen_data.get('product'))
        
        name = screen_data.get('name', 'Unknown Screen')
        version = screen_data.get('version', '')
        
        # 핵심 요약을 자연어 문장으로
        summary_parts = [f"'{name}'"]
        if product_name:
            summary_parts.append(f" 화면은 {product_name} 제품의 사용자 인터페이스입니다")
        summary = "".join(summary_parts) + "."
        
        # 마크다운 시작
        lines = [
            f"# {name}",
            "",
        ]
        
        # 관련 기능 (usage) - 자연어로
        usage = screen_data.get('usage', [])
        if usage:
            func_names = []
            for item in usage:
                item_name = item.get('name', '')
                if item_name:
                    func_names.append(item_name)
            
            if func_names:
                lines.extend([
                    "## 관련 기능",
                    f"이 화면에서 사용할 수 있는 기능: {', '.join(func_names)}.",
                    "",
                ])
        
        # 관련 링크
        link = screen_data.get('link', '')
        if link:
            lines.extend([
                "## 참고 자료",
                f"추가 정보: {link}",
                "",
            ])
        
        # 분류 정보
        context_parts = []
        if product_name:
            context_parts.append(f"제품: {product_name}")
        if version:
            context_parts.append(f"버전: {version}")
        if updated_date:
            context_parts.append(f"최종 수정: {updated_date}")
        
        if context_parts:
            lines.extend([
                "## 분류",
                ", ".join(context_parts) + ".",
                "",
            ])

        return "\n".join(lines).strip()

    def process_information(self, info_id):
        """특정 정보 문서를 처리하는 함수"""
        info_data = self.fetch_information_detail(info_id)
        if not info_data:
            return []

        content = self.create_information_markdown(info_data)
        title = info_data.get('name') or info_data.get('Name') or info_data.get('title', f"Information {info_id}")
        url = f"http://spms.sparrow.local/api/information/{info_id}"

        return self.create_document_from_api_content(title, content, url, "information", info_data)

    def process_screen(self, screen_id):
        """특정 화면 문서를 처리하는 함수"""
        screen_data = self.fetch_screen_detail(screen_id)
        if not screen_data:
            return []

        content = self.create_screens_markdown(screen_data)
        title = screen_data.get('name', f"Screen {screen_id}")
        url = f"http://spms.sparrow.local/api/screens/{screen_id}"

        return self.create_document_from_api_content(title, content, url, "screens", screen_data)

    def process_all_informations(self, max_pages=5):
        """모든 Information 문서를 처리하는 함수"""
        all_documents = []

        for page in range(1, max_pages + 1):
            information_list = self.fetch_information_list(page=page, size=20)
            if not information_list:
                break

            for info in information_list:
                info_id = info.get('id')
                if info_id:
                    docs = self.process_information(info_id)
                    all_documents.extend(docs)

        return all_documents

    def process_all_screens(self, max_pages=5):
        """모든 Screens 문서를 처리하는 함수"""
        all_documents = []

        for page in range(1, max_pages + 1):
            screens_list = self.fetch_screens_list(page=page, size=20)
            if not screens_list:
                break

            for screen in screens_list:
                screen_id = screen.get('id')
                if screen_id:
                    docs = self.process_screen(screen_id)
                    all_documents.extend(docs)

        return all_documents
