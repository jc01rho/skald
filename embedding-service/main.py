import asyncio
import logging
import os
import time
import threading
import random
from datetime import date
from typing import Literal, Optional, Union, Any
import httpx

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from fastapi.responses import StreamingResponse
import json

logger = logging.getLogger(__name__)

# Configure logging level from environment variable
LOG_LEVEL = os.getenv("LOG_LEVEL", "DEBUG").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))

app = FastAPI(title="Embedding Service", version="1.0.0")

# Global HTTPX client for reused connections and streaming stability
global_httpx_client = httpx.AsyncClient(timeout=300.0)


@app.on_event("shutdown")
async def shutdown_event():
    await global_httpx_client.aclose()


# Configuration
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3")
RERANK_MODEL = os.getenv("RERANK_MODEL", "xitao/bge-reranker-v2-m3:latest")
TARGET_DIMENSION = int(os.getenv("TARGET_DIMENSION", "768"))
EMBEDDING_PROVIDER = os.getenv(
    "EMBEDDING_PROVIDER", "external"
)  # local, ollama, gemini, or external
RERANK_PROVIDER = os.getenv("RERANK_PROVIDER", "ollama")  # local (CrossEncoder), ollama
QUERY_LANGUAGE = os.getenv("QUERY_LANGUAGE", "ko")  # 한글 최적화 기본값
_ollama_url = os.getenv("LOCAL_LLM_BASE_URL", "http://localhost:11434")
# Remove /v1 suffix if present (Ollama native API doesn't use /v1)
OLLAMA_BASE_URL = _ollama_url.rstrip("/").removesuffix("/v1")
SILICONFLOW_API_KEY = os.getenv("SILICONFLOW_API_KEY", "")
SILICONFLOW_BASE_URL = os.getenv("SILICONFLOW_BASE_URL", "")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "")
OPENROUTER_HTTP_REFERER = os.getenv("OPENROUTER_HTTP_REFERER", "")
# CLI Proxy API (OpenAI-compatible with multi-model support)
CLI_PROXY_API_KEY = os.getenv("CLI_PROXY_API_KEY", "")
CLI_PROXY_API_BASE_URL = os.getenv("CLI_PROXY_API_BASE_URL", "")
CLI_PROXY_MODELS_STR = os.getenv("CLI_PROXY_MODELS", "")
CLI_PROXY_MODELS = [m.strip() for m in CLI_PROXY_MODELS_STR.split(",") if m.strip()]

# OPENROUTER_API_KEY removed as per user request
# External embedding service URL (e.g., vLLM, TGI, or custom embedding server)
EXTERNAL_EMBEDDING_URL = os.getenv(
    "EXTERNAL_EMBEDDING_URL", "http://localhost:8889/embeddings"
)

# Local LLM endpoints for fallback when Groq payload is too large
# Configure via LOCAL_LLM_ENDPOINTS_JSON env var (JSON array)
# Example: '[{"name": "ollama-1", "url": "http://localhost:11434", "type": "ollama", "model": "llama3"}]'
LOCAL_LLM_ENDPOINTS_JSON = os.getenv("LOCAL_LLM_ENDPOINTS_JSON", "[]")
try:
    LOCAL_LLM_ENDPOINTS = json.loads(LOCAL_LLM_ENDPOINTS_JSON)
except json.JSONDecodeError:
    logger.warning("Invalid LOCAL_LLM_ENDPOINTS_JSON format, using empty list")
    LOCAL_LLM_ENDPOINTS = []


print(f"Using embedding provider: {EMBEDDING_PROVIDER}")
print(f"Using rerank provider: {RERANK_PROVIDER}")
print(f"Using embedding model: {EMBEDDING_MODEL}")
print(f"Using rerank model: {RERANK_MODEL}")
print(f"Using target dimension: {TARGET_DIMENSION}")
print(f"Query language: {QUERY_LANGUAGE}")
if EMBEDDING_PROVIDER == "external":
    print(f"Using external embedding URL: {EXTERNAL_EMBEDDING_URL}")

# Thread-safe usage tracking


class DailyUsageTracker:
    """
    Tracks daily usage and enforces a request limit.
    Resets automatically on day change.
    """

    def __init__(self, limit: int, name: str = "Unknown"):
        self.limit = limit
        self.name = name
        self.count = 0
        self.today = date.today()
        self._lock = threading.Lock()

    def can_make_request(self) -> bool:
        with self._lock:
            self._check_reset()
            return self.count < self.limit

    def record_request(self):
        with self._lock:
            self._check_reset()
            self.count += 1
            if self.count >= self.limit:
                logger.warning(f"🚨 {self.name} daily limit reached ({self.limit})")

    def _check_reset(self):
        now = date.today()
        if now != self.today:
            logger.info(
                f"📅 New day detected ({now}). Resetting {self.name} usage count from {self.count}"
            )
            self.today = now
            self.count = 0

    def get_status(self) -> dict:
        with self._lock:
            self._check_reset()
            return {
                "name": self.name,
                "count": self.count,
                "limit": self.limit,
                "remaining": max(0, self.limit - self.count),
            }


# Tracker for OpenRouter (800 calls per day)
openrouter_usage_tracker = DailyUsageTracker(limit=800, name="OpenRouter")


class RoundRobinManager:
    """
    Manages a list of items (keys, models, etc.) in a round-robin fashion.
    """

    def __init__(self, items: list[str], name: str = "Items"):
        self.items = items
        self.name = name
        self._index = 0
        self._lock = threading.Lock()

    def get_current(self) -> str:
        with self._lock:
            return self.items[self._index]

    def rotate(self):
        with self._lock:
            old = self.items[self._index]
            self._index = (self._index + 1) % len(self.items)
            logger.info(
                f"🔄 {self.name} rotated from {old} to {self.items[self._index]}"
            )

    def get_all(self) -> list[str]:
        return self.items


cli_proxy_model_manager = RoundRobinManager(CLI_PROXY_MODELS, name="CLI Proxy Models")


def _resolve_provider_model(env_var: str, requested_model: str) -> str:
    configured = os.getenv(env_var, "").strip()
    return configured or requested_model


# Dimension error cooldown management
class DimensionErrorCooldown:
    """
    Manages cooldown period when dimension mismatch errors occur.
    """

    def __init__(self, cooldown_seconds: float = 3600.0):  # 1 hour default
        self._cooldown_until: float = 0.0
        self._lock = threading.Lock()
        self._cooldown_duration = cooldown_seconds

    def is_in_cooldown(self) -> tuple[bool, float]:
        """Check if currently in cooldown. Returns (is_in_cooldown, remaining_seconds)."""
        with self._lock:
            current_time = time.time()
            if current_time < self._cooldown_until:
                remaining = self._cooldown_until - current_time
                return True, remaining
            return False, 0.0

    def activate_cooldown(self):
        """Activate cooldown period."""
        with self._lock:
            self._cooldown_until = time.time() + self._cooldown_duration
            logger.error(
                f"Dimension error detected! Embedding service entering {self._cooldown_duration / 60:.0f} minute cooldown."
            )


# OpenAI-compatible Chat Models
class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    stream: bool = False
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = None
    llm_provider: Optional[str] = None


# Initialize managers
dimension_error_cooldown = DimensionErrorCooldown(cooldown_seconds=3600.0)  # 1 hour

if EMBEDDING_PROVIDER == "ollama":
    print(f"Using Ollama base URL: {OLLAMA_BASE_URL}")

# Initialize models lazily based on provider
embedding_model = None
rerank_model = None

if EMBEDDING_PROVIDER == "local":
    try:
        from sentence_transformers import SentenceTransformer

        embedding_model = SentenceTransformer(EMBEDDING_MODEL)
        logger.info(f"Loaded local embedding model: {EMBEDDING_MODEL}")
    except Exception as e:
        logger.error(f"Failed to load local embedding model: {e}")
        logger.info("Falling back to Ollama provider for embedding")
        EMBEDDING_PROVIDER = "ollama"

# CrossEncoder for reranking (local)
if RERANK_PROVIDER == "local":
    try:
        from sentence_transformers import CrossEncoder

        rerank_model = CrossEncoder(RERANK_MODEL)
        logger.info(f"Loaded local CrossEncoder rerank model: {RERANK_MODEL}")
    except Exception as e:
        logger.error(f"Failed to load local CrossEncoder rerank model: {e}")
        logger.info("Falling back to Ollama provider for rerank")
        RERANK_PROVIDER = "ollama"


# Korean morphological analyzer for BM25 tokenization
kiwi_instance = None
try:
    from kiwipiepy import Kiwi

    kiwi_instance = Kiwi()
    logger.info("Kiwi Korean morphological analyzer loaded successfully")
except ImportError:
    logger.warning(
        "kiwipiepy not installed. Korean tokenization will not be available."
    )
except Exception as e:
    logger.error(f"Failed to initialize Kiwi: {e}")

# Meaningful POS tags for BM25 search (from OneRAG reference)
# NNG: 일반 명사, NNP: 고유 명사, NNB: 의존 명사
# VV: 동사, VA: 형용사, MAG: 일반 부사
# SL: 외국어, SN: 숫자, SH: 한자
_MEANINGFUL_POS_TAGS = frozenset({"NNG", "NNP", "VV", "VA", "MAG", "SL", "SN", "SH"})

# Korean stopwords (from OneRAG reference)
KOREAN_STOPWORDS = frozenset(
    {
        # 조사
        "은",
        "는",
        "이",
        "가",
        "을",
        "를",
        "의",
        "에",
        "에서",
        "로",
        "으로",
        "와",
        "과",
        "도",
        "만",
        "부터",
        "까지",
        "라",
        "이라",
        # 접속부사
        "그리고",
        "그러나",
        "하지만",
        "그래서",
        "따라서",
        # 대명사
        "이것",
        "그것",
        "저것",
        "이거",
        "그거",
        "저거",
        # 기타 고빈도 저정보 단어
        "것",
        "수",
        "등",
        "때",
        "중",
    }
)


# ============================================================
# 한글 최적화 함수들
# ============================================================


def preprocess_korean_query(query: str) -> str:
    """
    한글 쿼리 전처리 함수
    - 불필요한 공백 제거
    - 조사 뒤 공백 삽입으로 검색 품질 향상
    - 특수문자 정리
    """
    import re

    # 중복 공백 제거
    query = re.sub(r"\s+", " ", query.strip())

    # 한글 쿼리인 경우 특수 처리
    if is_korean_text(query):
        # 조사 뒤에 붙은 한글 단어 사이에 공백 삽입
        # 예: "삼성전자의주가" → "삼성전자의 주가"
        query = re.sub(
            r"([가-힣])(은|는|이|가|을|를|의|에서|에|로|으로|와|과|도)([가-힣])",
            r"\1\2 \3",
            query,
        )
        # 특수문자 정리 (한글, 영문, 숫자, 공백만 유지)
        query = re.sub(r"[^\w\s가-힣a-zA-Z0-9]", " ", query)
        query = re.sub(r"\s+", " ", query.strip())

    return query


def is_korean_text(text: str) -> bool:
    """텍스트가 한글을 포함하는지 확인"""
    import re

    korean_pattern = re.compile(r"[가-힣]")
    return bool(korean_pattern.search(text))


def get_task_type_for_korean(usage: str) -> str:
    """
    한글 텍스트에 최적화된 task_type 반환
    Gemini embedding은 task_type에 따라 임베딩 방식이 달라짐
    """
    if usage == "search" or usage == "query":
        return "retrieval_query"
    else:
        return "retrieval_document"


# ============================================================
# Embedding 함수들
# ============================================================


def normalize_embedding(embedding: list[float]) -> list[float]:
    """Pad or validate embedding to match TARGET_DIMENSION"""
    current_dim = len(embedding)

    if current_dim == TARGET_DIMENSION:
        return embedding
    elif current_dim < TARGET_DIMENSION:
        # Pad with zeros
        return embedding + [0.0] * (TARGET_DIMENSION - current_dim)
    else:
        # Vector too large - truncate (slicing)
        # Matryoshka Representation Learning 지원 모델은 앞부분만 사용해도 성능이 유지됨
        return embedding[:TARGET_DIMENSION]


async def get_ollama_embedding(text: str) -> list[float]:
    """Get embedding from Ollama API"""
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.post(
                f"{OLLAMA_BASE_URL}/api/embeddings",
                json={"model": EMBEDDING_MODEL, "prompt": text},
            )
            response.raise_for_status()
            data = response.json()
            return data["embedding"]
        except httpx.HTTPStatusError as e:
            logger.error(
                f"Ollama API error: {e.response.status_code} - {e.response.text}"
            )
            raise HTTPException(status_code=502, detail=f"Ollama API error: {str(e)}")
        except Exception as e:
            logger.error(f"Failed to get embedding from Ollama: {str(e)}")
            raise HTTPException(
                status_code=500, detail=f"Ollama connection failed: {str(e)}"
            )


async def get_external_embedding(text: str) -> list[float]:
    """
    Get embedding from external embedding service (vLLM, TGI, or OpenAI-compatible API).
    Supports both OpenAI-compatible format and simple embedding format.
    """
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            # Try OpenAI-compatible format first
            response = await client.post(
                EXTERNAL_EMBEDDING_URL,
                json={"model": EMBEDDING_MODEL, "input": text},
                headers={"Content-Type": "application/json"},
            )
            response.raise_for_status()
            data = response.json()

            # Handle different response formats
            if "data" in data and len(data["data"]) > 0:
                # OpenAI-compatible format: {"data": [{"embedding": [...]}]}
                embedding = data["data"][0]["embedding"]
            elif "embedding" in data:
                # Simple format: {"embedding": [...]}
                embedding = data["embedding"]
            elif "embeddings" in data:
                # Alternative format: {"embeddings": [[...]]}
                embedding = (
                    data["embeddings"][0]
                    if isinstance(data["embeddings"][0], list)
                    else data["embeddings"]
                )
            else:
                logger.error(
                    f"Unexpected response format from external embedding service: {data.keys()}"
                )
                raise HTTPException(
                    status_code=500, detail=f"Unexpected response format: {data.keys()}"
                )

            logger.debug(
                f"Got embedding from external service, dimension: {len(embedding)}"
            )
            return embedding

        except httpx.HTTPStatusError as e:
            logger.error(
                f"External embedding API error: {e.response.status_code} - {e.response.text}"
            )
            raise HTTPException(
                status_code=502, detail=f"External embedding API error: {str(e)}"
            )
        except Exception as e:
            logger.error(f"Failed to get embedding from external service: {str(e)}")
            raise HTTPException(
                status_code=500,
                detail=f"External embedding connection failed: {str(e)}",
            )


def _gemini_call(
    text: str,
    api_key: str,
    model: str,
    task_type: str = "retrieval_document",
    key_index: int = 0,
    total_keys: int = 1,
) -> list[float]:
    """
    Gemini 임베딩 API 호출
    한글 텍스트에 최적화된 task_type 사용
    output_dimensionality를 사용하여 차원을 TARGET_DIMENSION에 맞춤 (Matryoshka Representation Learning 지원 모델)
    """
    logger.debug(f"Using Gemini API key [{key_index + 1}/{total_keys}]")
    genai.configure(api_key=api_key)

    # output_dimensionality 지원 여부는 모델에 따라 다르지만,
    # 최신 모델들은 지원하며 지원하지 않는 경우 무시되거나 에러가 발생할 수 있음.
    # 안전하게 try-except 또는 파라미터 전달
    try:
        result = genai.embed_content(
            model=model,
            content=text,
            task_type=task_type,
            output_dimensionality=TARGET_DIMENSION,
        )
    except TypeError:
        # output_dimensionality 파라미터를 지원하지 않는 경우 (구버전 라이브러리 등)
        logger.warning(
            f"Model {model} does not support output_dimensionality parameter, falling back to default"
        )
        result = genai.embed_content(model=model, content=text, task_type=task_type)

    embedding = result["embedding"]

    # Log dimension info for debugging (MRL truncation happens in normalize_embedding)
    if len(embedding) != TARGET_DIMENSION:
        logger.debug(
            f"Gemini embedding dimension {len(embedding)} will be normalized to {TARGET_DIMENSION} via MRL truncation"
        )

    return embedding


async def get_gemini_embedding(text: str, usage: str = "storage") -> list[float]:
    """
    Get embedding from Gemini API using exhaustion-based round-robin keys.
    Uses one key until it's exhausted (rate-limited), then switches to the next.
    한글 텍스트에 최적화된 task_type 자동 선택
    """
    # Check dimension error cooldown first
    is_cooldown, remaining = dimension_error_cooldown.is_in_cooldown()
    if is_cooldown:
        remaining_minutes = remaining / 60
        error_msg = f"Embedding service in cooldown due to dimension error. Retry after {remaining_minutes:.1f} minutes."
        logger.warning(error_msg)
        raise HTTPException(status_code=503, detail=error_msg)

    if not gemini_key_manager:
        raise HTTPException(status_code=503, detail="No Gemini API keys configured")

    # 한글 최적화: 적절한 task_type 선택
    task_type = get_task_type_for_korean(usage)

    # 한글 쿼리 전처리
    processed_text = preprocess_korean_query(text) if usage == "search" else text

    max_retries = gemini_key_manager.get_key_count()
    last_error = None

    for attempt in range(max_retries):
        current_key, key_index = gemini_key_manager.get_current_key()

        try:
            return await run_in_threadpool(
                _gemini_call,
                processed_text,
                current_key,
                EMBEDDING_MODEL,
                task_type,
                key_index,
                gemini_key_manager.get_key_count(),
            )
        except ValueError as e:
            # Dimension mismatch error - activate 1 hour cooldown
            error_str = str(e)
            if "dimension" in error_str.lower() and "exceeds" in error_str.lower():
                dimension_error_cooldown.activate_cooldown()
                raise HTTPException(
                    status_code=503,
                    detail=f"Dimension error detected. Service entering 1-hour cooldown. Error: {error_str}",
                )
            raise HTTPException(
                status_code=500, detail=f"Gemini API error: {error_str}"
            )
        except Exception as e:
            error_str = str(e)
            last_error = e

            # Check for rate limit (429) or quota exceeded errors
            is_rate_limit = (
                "429" in error_str
                or "rate" in error_str.lower()
                or "quota" in error_str.lower()
                or "resource_exhausted" in error_str.lower()
            )

            if is_rate_limit:
                # Mark this key as rate-limited and try next key
                gemini_key_manager.mark_rate_limited(current_key, cooldown_seconds=60.0)
                logger.warning(
                    f"Rate limit hit on key [{key_index + 1}/{gemini_key_manager.get_key_count()}], trying next key (attempt {attempt + 1}/{max_retries})"
                )
                continue
            else:
                # Non-rate-limit error, don't retry
                logger.error(f"Failed to get embedding from Gemini: {error_str}")
                raise HTTPException(
                    status_code=500, detail=f"Gemini API error: {error_str}"
                )

    # All retries exhausted
    logger.error(f"All {max_retries} API keys exhausted due to rate limiting")
    raise HTTPException(
        status_code=429,
        detail=f"All API keys rate-limited. Please try again later. Last error: {str(last_error)}",
    )


async def get_ollama_rerank_embedding(text: str) -> list[float]:
    """Get embedding from Ollama API using the rerank model"""
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.post(
                f"{OLLAMA_BASE_URL}/api/embeddings",
                json={"model": RERANK_MODEL, "prompt": text},
            )
            response.raise_for_status()
            data = response.json()
            return data["embedding"]
        except httpx.HTTPStatusError as e:
            logger.error(
                f"Ollama rerank API error: {e.response.status_code} - {e.response.text}"
            )
            raise HTTPException(
                status_code=502, detail=f"Ollama rerank API error: {str(e)}"
            )
        except Exception as e:
            logger.error(f"Failed to get rerank embedding from Ollama: {str(e)}")
            raise HTTPException(
                status_code=500, detail=f"Ollama rerank connection failed: {str(e)}"
            )


def cosine_similarity(vec1: list[float], vec2: list[float]) -> float:
    """Compute cosine similarity between two vectors"""
    arr1 = np.array(vec1)
    arr2 = np.array(vec2)
    dot_product = np.dot(arr1, arr2)
    norm1 = np.linalg.norm(arr1)
    norm2 = np.linalg.norm(arr2)
    if norm1 == 0 or norm2 == 0:
        return 0.0
    return float(dot_product / (norm1 * norm2))


# ============================================================
# Reranking 함수들
# ============================================================


async def rerank_with_ollama(
    query: str, documents: list[str]
) -> list[tuple[int, float]]:
    """
    Rerank documents using Ollama embedding model (fallback).
    Returns list of (index, score) tuples sorted by score descending.
    """
    # Get query embedding
    query_embedding = await get_ollama_rerank_embedding(query)

    # Get document embeddings in parallel
    doc_embeddings = await asyncio.gather(
        *[get_ollama_rerank_embedding(doc) for doc in documents]
    )

    # Compute cosine similarities
    scores = []
    for idx, doc_emb in enumerate(doc_embeddings):
        score = cosine_similarity(query_embedding, doc_emb)
        # Normalize to 0-1 range (cosine similarity is -1 to 1)
        normalized_score = (score + 1) / 2
        scores.append((idx, normalized_score))

    # Sort by score descending
    scores.sort(key=lambda x: x[1], reverse=True)
    return scores


def _rerank_with_crossencoder(
    query: str, documents: list[str]
) -> list[tuple[int, float]]:
    """
    CrossEncoder를 사용한 진정한 리랭킹 (bi-encoder 아님)
    한글 최적화 모델 사용 시 더 높은 성능 발휘
    """
    if rerank_model is None:
        raise ValueError("CrossEncoder rerank model not loaded")

    # 한글 쿼리 전처리
    processed_query = preprocess_korean_query(query)

    # CrossEncoder는 (query, document) 쌍을 직접 입력받아 relevance score 출력
    pairs = [[processed_query, doc] for doc in documents]

    # CrossEncoder predict - 직접적인 relevance score 반환
    scores = rerank_model.predict(pairs)

    # Sigmoid를 통해 0-1 범위로 정규화
    normalized_scores = 1 / (1 + np.exp(-np.array(scores)))

    # (index, score) 튜플 리스트 생성
    indexed_scores = [
        (idx, float(score)) for idx, score in enumerate(normalized_scores)
    ]

    # 점수 기준 내림차순 정렬
    indexed_scores.sort(key=lambda x: x[1], reverse=True)

    return indexed_scores


async def rerank_with_local_crossencoder(
    query: str, documents: list[str]
) -> list[tuple[int, float]]:
    """
    로컬 CrossEncoder를 사용한 비동기 리랭킹
    sentence-transformers의 CrossEncoder 사용
    """
    return await run_in_threadpool(_rerank_with_crossencoder, query, documents)


# ============================================================
# Pydantic 모델들
# ============================================================


class EmbedRequest(BaseModel):
    content: str = Field(..., description="Text content to embed")
    normalize: bool = Field(
        default=True, description="Whether to normalize to target dimension"
    )
    usage: str = Field(
        default="storage",
        description="Usage type: 'storage' for documents, 'search' for queries",
    )


class EmbedResponse(BaseModel):
    embedding: list[float] = Field(..., description="The generated embedding vector")
    dimension: int = Field(..., description="Dimension of the embedding vector")


class OpenAIEmbedRequest(BaseModel):
    input: Union[str, list[str]] = Field(..., description="The input text to embed")
    model: str = Field(..., description="The model ID to use")
    user: Optional[str] = None


class OpenAIEmbedData(BaseModel):
    object: str = "embedding"
    embedding: list[float]
    index: int


class OpenAIEmbedUsage(BaseModel):
    prompt_tokens: int = 0
    total_tokens: int = 0


class OpenAIEmbedResponse(BaseModel):
    object: str = "list"
    data: list[OpenAIEmbedData]
    model: str
    usage: OpenAIEmbedUsage


class RerankDocument(BaseModel):
    text: str = Field(..., description="Document text to rerank")
    index: int = Field(
        ..., description="Original index of the document in the input list"
    )


class RerankRequest(BaseModel):
    query: str = Field(..., description="The search query")
    documents: list[str] = Field(..., description="List of documents to rerank")
    top_k: int = Field(default=None, description="Number of top results to return")


class RerankResult(BaseModel):
    index: int = Field(..., description="Original index of the document")
    document: str = Field(..., description="Document text")
    relevance_score: float = Field(..., description="Relevance score for the document")


class RerankResponse(BaseModel):
    results: list[RerankResult] = Field(
        ..., description="Reranked documents with scores"
    )


class TokenizeRequest(BaseModel):
    text: str = Field(..., description="Text to tokenize")
    filter_pos: bool = Field(
        default=True, description="Filter to meaningful POS tags only"
    )
    filter_stopwords: bool = Field(default=True, description="Remove Korean stopwords")


class TokenizeResponse(BaseModel):
    tokens: list[str] = Field(..., description="Tokenized result")
    original_length: int = Field(..., description="Original text length")


# ============================================================
# API Endpoints
# ============================================================


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "embedding_provider": EMBEDDING_PROVIDER,
        "rerank_provider": RERANK_PROVIDER,
        "rerank_model": RERANK_MODEL,
        "embedding_model": EMBEDDING_MODEL,
        "query_language": QUERY_LANGUAGE,
        "kiwi_tokenizer": kiwi_instance is not None,
    }


@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest):
    """
    Generate embeddings for the provided text content.
    한글 텍스트에 최적화된 임베딩 생성

    Args:
        request: EmbedRequest containing the text content and normalization preference

    Returns:
        EmbedResponse with the embedding vector and its dimension
    """
    try:
        usage = request.usage if hasattr(request, "usage") else "storage"

        if EMBEDDING_PROVIDER == "ollama":
            embedding = await get_ollama_embedding(request.content)
        elif EMBEDDING_PROVIDER == "external":
            # 한글 쿼리 전처리
            processed_content = (
                preprocess_korean_query(request.content)
                if usage == "search"
                else request.content
            )
            embedding = await get_external_embedding(processed_content)
        elif EMBEDDING_PROVIDER == "local":
            if embedding_model is None:
                raise HTTPException(
                    status_code=503, detail="Local embedding model not available"
                )
            # 한글 쿼리 전처리
            processed_content = (
                preprocess_korean_query(request.content)
                if usage == "search"
                else request.content
            )
            embedding = embedding_model.encode(processed_content).tolist()
        else:
            raise HTTPException(
                status_code=501, detail=f"Provider {EMBEDDING_PROVIDER} not implemented"
            )

        if request.normalize:
            embedding = normalize_embedding(embedding)

        return EmbedResponse(embedding=embedding, dimension=len(embedding))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Embedding generation failed: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Embedding generation failed: {str(e)}"
        )


@app.post("/v1/embeddings", response_model=OpenAIEmbedResponse)
async def v1_embeddings(request: OpenAIEmbedRequest):
    try:
        inputs = [request.input] if isinstance(request.input, str) else request.input
        usage = "storage"

        results = []
        total_tokens = 0

        for i, content in enumerate(inputs):
            if EMBEDDING_PROVIDER == "ollama":
                embedding = await get_ollama_embedding(content)
            elif EMBEDDING_PROVIDER == "external":
                processed_content = (
                    preprocess_korean_query(content) if usage == "search" else content
                )
                embedding = await get_external_embedding(processed_content)
            elif EMBEDDING_PROVIDER == "local":
                if embedding_model is None:
                    raise HTTPException(
                        status_code=503, detail="Local embedding model not available"
                    )
                processed_content = (
                    preprocess_korean_query(content) if usage == "search" else content
                )
                embedding = embedding_model.encode(processed_content).tolist()
            elif EMBEDDING_PROVIDER == "gemini":
                embedding = await get_gemini_embedding(content, usage=usage)
            else:
                raise HTTPException(
                    status_code=501,
                    detail=f"Provider {EMBEDDING_PROVIDER} not implemented",
                )

            embedding = normalize_embedding(embedding)

            results.append(OpenAIEmbedData(embedding=embedding, index=i))
            total_tokens += len(content) // 4

        return OpenAIEmbedResponse(
            data=results,
            model=request.model,
            usage=OpenAIEmbedUsage(
                prompt_tokens=total_tokens, total_tokens=total_tokens
            ),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"V1 Embedding generation failed: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Embedding generation failed: {str(e)}"
        )


@app.post("/rerank", response_model=RerankResponse)
async def rerank(request: RerankRequest):
    """
    Rerank documents based on their relevance to the query using CrossEncoder.
    한국어 최적화 CrossEncoder 모델을 사용한 리랭킹

    Args:
        request: RerankRequest containing the query and documents to rerank

    Returns:
        RerankResponse with reranked documents sorted by relevance score
    """
    start_time = time.perf_counter()
    logger.debug(
        f"Rerank request received: query length={len(request.query)}, documents count={len(request.documents)}, top_k={request.top_k}"
    )

    try:
        check_start = time.perf_counter()
        if not request.documents:
            logger.debug(
                f"Empty documents list, returning empty results (took {time.perf_counter() - check_start:.6f}s)"
            )
            return RerankResponse(results=[])
        logger.debug(
            f"Documents check completed (took {time.perf_counter() - check_start:.6f}s)"
        )

        # CrossEncoder를 사용한 로컬 리랭킹 (권장)
        if RERANK_PROVIDER == "local" and rerank_model is not None:
            logger.debug(f"Using local CrossEncoder rerank with model: {RERANK_MODEL}")

            def get_document_text(doc):
                if isinstance(doc, str):
                    return doc
                if isinstance(doc, dict):
                    for field in ["text", "content", "document", "page_content"]:
                        if field in doc:
                            return doc[field]
                return str(doc)

            doc_texts = [get_document_text(doc) for doc in request.documents]
            crossencoder_start = time.perf_counter()
            scores = await rerank_with_local_crossencoder(request.query, doc_texts)
            logger.debug(
                f"CrossEncoder rerank completed (took {time.perf_counter() - crossencoder_start:.6f}s)"
            )

            reranked = []
            for idx, score in scores:
                reranked.append(
                    RerankResult(
                        index=idx,
                        document=doc_texts[idx],
                        relevance_score=float(f"{score:.6f}"),
                    )
                )

            if isinstance(request.top_k, int) and request.top_k > 0:
                reranked = reranked[: request.top_k]

            total_time = time.perf_counter() - start_time
            logger.debug(
                f"Rerank completed successfully: returning {len(reranked)} results (total time: {total_time:.6f}s)"
            )
            return RerankResponse(results=reranked)

        # Ollama 기반 리랭킹 (fallback)
        elif RERANK_PROVIDER == "ollama":
            logger.debug(f"Using Ollama rerank with model: {RERANK_MODEL}")

            def get_document_text(doc):
                if isinstance(doc, str):
                    return doc
                if isinstance(doc, dict):
                    for field in ["text", "content", "document", "page_content"]:
                        if field in doc:
                            return doc[field]
                return str(doc)

            doc_texts = [get_document_text(doc) for doc in request.documents]
            ollama_start = time.perf_counter()
            scores = await rerank_with_ollama(request.query, doc_texts)
            logger.debug(
                f"Ollama rerank completed (took {time.perf_counter() - ollama_start:.6f}s)"
            )

            reranked = []
            for idx, score in scores:
                reranked.append(
                    RerankResult(
                        index=idx,
                        document=doc_texts[idx],
                        relevance_score=float(f"{score:.6f}"),
                    )
                )

            if isinstance(request.top_k, int) and request.top_k > 0:
                reranked = reranked[: request.top_k]

            total_time = time.perf_counter() - start_time
            logger.debug(
                f"Rerank completed successfully: returning {len(reranked)} results (total time: {total_time:.6f}s)"
            )
            return RerankResponse(results=reranked)

        else:
            # Fallback: return documents in original order with decreasing scores
            logger.warning("Rerank model not available, using fallback scoring")
            reranked = []
            for idx, doc in enumerate(request.documents):
                score = 1.0 - (idx * 0.01)  # Simple decreasing scores
                reranked.append(
                    RerankResult(
                        index=idx,
                        document=doc if isinstance(doc, str) else str(doc),
                        relevance_score=float(f"{score:.6f}"),
                    )
                )
            if isinstance(request.top_k, int) and request.top_k > 0:
                reranked = reranked[: request.top_k]
            return RerankResponse(results=reranked)

    except Exception as e:
        total_time = time.perf_counter() - start_time
        logger.error(f"Rerank failed after {total_time:.6f}s: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Reranking failed: {str(e)}")


@app.post("/tokenize", response_model=TokenizeResponse)
async def tokenize_text(request: TokenizeRequest):
    """
    한국어 형태소 분석 기반 토큰화
    Kiwi 형태소 분석기를 사용하여 의미 있는 토큰만 추출합니다.
    BM25 검색의 한국어 품질 향상을 위해 사용됩니다.
    """
    if kiwi_instance is None:
        raise HTTPException(
            status_code=503,
            detail="Kiwi morphological analyzer not available. Install kiwipiepy.",
        )

    try:
        text = request.text.strip()
        if not text:
            return TokenizeResponse(tokens=[], original_length=0)

        tokens: list[str] = []
        for token in kiwi_instance.tokenize(text):
            # Filter by meaningful POS tags
            if request.filter_pos and token.tag not in _MEANINGFUL_POS_TAGS:
                continue
            form = token.form.strip()
            if not form:
                continue
            # Filter stopwords
            if request.filter_stopwords and form in KOREAN_STOPWORDS:
                continue
            tokens.append(form)

        logger.debug(f"Tokenized '{text[:50]}...' -> {len(tokens)} tokens")
        return TokenizeResponse(tokens=tokens, original_length=len(text))
    except Exception as e:
        logger.error(f"Tokenization failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Tokenization failed: {str(e)}")


# ============================================================
# 추가 유틸리티 엔드포인트
# ============================================================


class KeyValidationResult(BaseModel):
    key_mask: str
    is_valid: bool
    error_message: Optional[str] = None
    status_code: Optional[int] = None


@app.post("/api-keys/validate")
async def validate_api_keys():
    raise HTTPException(status_code=410, detail="Groq provider has been removed")


@app.get("/info")
async def get_info():
    """서비스 정보 및 현재 설정 반환"""
    return {
        "service": "Embedding Service",
        "version": "1.1.0",
        "features": {
            "korean_optimization": True,
            "crossencoder_reranking": RERANK_PROVIDER == "local"
            and rerank_model is not None,
        },
        "configuration": {
            "embedding_provider": EMBEDDING_PROVIDER,
            "embedding_model": EMBEDDING_MODEL,
            "rerank_provider": RERANK_PROVIDER,
            "rerank_model": RERANK_MODEL,
            "target_dimension": TARGET_DIMENSION,
            "query_language": QUERY_LANGUAGE,
        },
        "models_loaded": {
            "embedding_model": embedding_model is not None
            if EMBEDDING_PROVIDER == "local"
            else "external",
            "rerank_model": rerank_model is not None,
        },
    }


@app.get("/api-keys/status")
async def get_api_keys_status():
    return {
        "provider": EMBEDDING_PROVIDER,
        "message": "Groq provider has been removed",
        "keys": None,
    }


async def _call_local_llm_fallback(
    messages: list[dict], temperature: float | None = 0.7, max_tokens: int | None = 4096
) -> dict | None:
    """
    Call local LLM endpoints when Groq returns 413 Payload Too Large.
    Randomly selects between available local LLM endpoints.

    Includes 15-second cooldown to prevent excessive calls.

    Supported endpoints:
    1. ollama-kanana (http://192.168.30.169:11434) - Ollama API
    """
    # No cooldown check here, as the main chat_completions function handles it
    # or it's called as a direct fallback.

    if not LOCAL_LLM_ENDPOINTS:
        logger.warning("No local LLM endpoints configured")
        return None

    # Randomly shuffle endpoints for load balancing
    endpoints = LOCAL_LLM_ENDPOINTS.copy()
    random.shuffle(endpoints)

    last_error = None

    for endpoint in endpoints:
        endpoint_name = endpoint["name"]
        endpoint_url = endpoint["url"]
        endpoint_type = endpoint["type"]
        endpoint_model = endpoint.get("model")

        logger.info(f"Trying local LLM fallback: {endpoint_name} ({endpoint_type})")

        try:
            async with httpx.AsyncClient(timeout=600.0) as client:
                if endpoint_type == "ollama":
                    # Ollama API format
                    ollama_url = f"{endpoint_url}/api/chat"

                    # Convert messages to Ollama format
                    ollama_messages = [
                        {"role": m["role"], "content": m["content"]} for m in messages
                    ]

                    payload = {
                        "model": endpoint_model,
                        "messages": ollama_messages,
                        "stream": False,
                        "options": {},
                    }
                    if temperature is not None:
                        payload["options"]["temperature"] = temperature
                    if max_tokens is not None:
                        payload["options"]["num_predict"] = max_tokens

                    response = await client.post(
                        ollama_url,
                        json=payload,
                        headers={"Content-Type": "application/json"},
                    )
                    response.raise_for_status()
                    data = response.json()

                    # Log raw output for debugging
                    logger.debug(f"Ollama response data: {str(data)[:200]}...")

                    content = ""
                    if "message" in data and "content" in data["message"]:
                        content = data["message"]["content"]
                    elif "response" in data:
                        content = data["response"]
                    else:
                        logger.error(
                            f"Unexpected Ollama response format: {data.keys()}"
                        )

                    logger.info(f"Local LLM fallback ({endpoint_name}) succeeded")
                    return {
                        "id": f"chatcmpl-local-{int(time.time())}",
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": f"local/{endpoint_model or endpoint_name}",
                        "choices": [
                            {
                                "index": 0,
                                "message": {"role": "assistant", "content": content},
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {
                            "prompt_tokens": data.get(
                                "prompt_eval_count",
                                sum(
                                    len(m.get("content", "") or "") // 4
                                    for m in messages
                                ),
                            ),
                            "completion_tokens": data.get(
                                "eval_count", len(content) // 4
                            ),
                            "total_tokens": data.get("prompt_eval_count", 0)
                            + data.get("eval_count", 0),
                        },
                    }
                else:
                    logger.warning(f"Unknown endpoint type: {endpoint_type}")
                    continue

        except httpx.HTTPStatusError as e:
            last_error = e
            logger.warning(
                f"Local LLM fallback ({endpoint_name}) HTTP error: {e.response.status_code} - {e.response.text[:200]}"
            )
            continue
        except Exception as e:
            last_error = e
            logger.warning(f"Local LLM fallback ({endpoint_name}) failed: {str(e)}")
            continue

    # All endpoints failed
    if last_error:
        raise last_error
    return None


async def _stream_single_response(response_dict: dict):
    """
    Converts a single JSON response into an SSE stream.
    Used for local fallback when the client requested a stream but we got a full response.
    """
    try:
        # Extract content from the response
        content = ""
        if "choices" in response_dict and len(response_dict["choices"]) > 0:
            message = response_dict["choices"][0].get("message", {})
            content = message.get("content", "")

        model = response_dict.get("model", "local-fallback")
        created = response_dict.get("created", int(time.time()))
        completion_id = response_dict.get("id", f"chatcmpl-{created}")

        # Create a single chunk with content
        chunk_data = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [
                {"index": 0, "delta": {"content": content}, "finish_reason": None}
            ],
        }
        yield f"data: {json.dumps(chunk_data)}\n\n"

        # Send finish chunk
        finish_data = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        yield f"data: {json.dumps(finish_data)}\n\n"
        yield "data: [DONE]\n\n"

    except Exception as e:
        logger.error(f"Error streaming single response: {e}")
        error_data = {"error": str(e)}
        yield f"data: {json.dumps(error_data)}\n\n"


class MemoProcessingThrottler:
    """
    Throttler for memo processing to enforce a duty cycle:
    - Run for 120 seconds
    - Wait for 3 minutes (180 seconds)
    """

    def __init__(self, run_duration: float = 30.0, cooldown_duration: float = 600.0):
        self.run_duration = run_duration
        self.cooldown_duration = cooldown_duration
        self.state: Literal["IDLE", "RUNNING", "COOLDOWN"] = "IDLE"
        self.cycle_start_time = 0.0
        self.cooldown_start_time = 0.0
        self._lock = asyncio.Lock()

    async def check_throttling(
        self, model: str = "unknown", key_info: str = "unknown"
    ) -> tuple[bool, float, str]:
        """
        Check if request is allowed.
        Returns: (is_allowed, wait_time, message)
        """
        async with self._lock:
            now = time.time()

            if self.state == "IDLE":
                # Start new cycle
                self.state = "RUNNING"
                self.cycle_start_time = now
                logger.info(
                    f"Memo Processing Throttler: Starting NEW cycle (Running for {self.run_duration}s)"
                )
                return True, 0.0, ""

            elif self.state == "RUNNING":
                elapsed = now - self.cycle_start_time
                if elapsed > self.run_duration:
                    # Time's up, enter cooldown
                    self.state = "COOLDOWN"
                    self.cooldown_start_time = now
                    remaining = self.cooldown_duration
                    logger.warning(
                        f"Memo Processing Throttler: Run time exceeded ({elapsed:.1f}s). Entering COOLDOWN for {self.cooldown_duration}s. Model: {model}, Key: {key_info}"
                    )
                    return (
                        False,
                        remaining,
                        f"Memo processing limit reached. Cooling down for {int(remaining)}s. Model: {model}, Key: {key_info}",
                    )
                else:
                    return True, 0.0, ""

            elif self.state == "COOLDOWN":
                elapsed = now - self.cooldown_start_time
                if elapsed > self.cooldown_duration:
                    # Cooldown finished, back to IDLE (or start running immediately)
                    self.state = "RUNNING"
                    self.cycle_start_time = now
                    logger.info(
                        f"Memo Processing Throttler: Cooldown finished. Starting NEW cycle."
                    )
                    return True, 0.0, ""
                else:
                    remaining = self.cooldown_duration - elapsed
                    return (
                        False,
                        remaining,
                        f"Memo processing in cooldown. Wait {int(remaining)}s. Model: {model}, Key: {key_info}",
                    )

            return True, 0.0, ""


memo_throttler = MemoProcessingThrottler(run_duration=120.0, cooldown_duration=180.0)


async def _call_siliconflow(
    messages: list[dict],
    model: str,
    temperature: float = 0.7,
    max_tokens: int = 4095,
    stream: bool = False,
):
    if not SILICONFLOW_API_KEY:
        return None

    if not SILICONFLOW_BASE_URL:
        return None
    url = f"{SILICONFLOW_BASE_URL.rstrip('/')}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {SILICONFLOW_API_KEY}",
        "Content-Type": "application/json",
    }

    # Check if JSON format is requested
    is_json = any("json" in m.get("content", "").lower() for m in messages)

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream,
        "enable_thinking": False,
        "thinking_budget": 4096,
        "min_p": 0.05,
        "top_p": 0.7,
        "top_k": 50,
        "frequency_penalty": 0.5,
        "n": 1,
    }

    if is_json:
        payload["response_format"] = {"type": "json_object"}

    if stream:
        return await global_httpx_client.post(url, json=payload, headers=headers)
    else:
        response = await global_httpx_client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        return response.json()


async def _stream_siliconflow_response(response, model_name):
    """
    Stream SiliconFlow API response in OpenAI format.
    """
    try:
        async for line in response.aiter_lines():
            if not line.strip():
                continue
            if line.startswith("data: "):
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    yield "data: [DONE]\n\n"
                    break

                try:
                    # SiliconFlow typically returns OpenAI format
                    yield f"data: {data_str}\n\n"
                except Exception:
                    continue
    except Exception as e:
        logger.error(f"Error during SiliconFlow streaming: {e}")
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
    finally:
        await response.aclose()


async def _call_openrouter(
    messages: list[dict],
    model: str,
    temperature: float = 0.7,
    max_tokens: int = 4096,
    stream: bool = False,
):
    if not OPENROUTER_API_KEY:
        return None

    if not OPENROUTER_BASE_URL:
        return None
    url = f"{OPENROUTER_BASE_URL.rstrip('/')}/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": OPENROUTER_HTTP_REFERER,
        "X-Title": "Skald AI",
    }

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream,
    }

    if stream:
        return await global_httpx_client.post(url, json=payload, headers=headers)
    else:
        response = await global_httpx_client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        return response.json()


async def _stream_openrouter_response(response, model_name):
    """
    Stream OpenRouter API response in OpenAI format.
    """
    try:
        async for line in response.aiter_lines():
            if not line.strip():
                continue
            if line.startswith("data: "):
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    yield "data: [DONE]\n\n"
                    break

                yield f"data: {data_str}\n\n"
    except Exception as e:
        logger.error(f"Error during OpenRouter streaming: {e}")
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
    finally:
        await response.aclose()


async def _call_cli_proxy(
    messages: list[dict],
    model: str,
    temperature: float = 0.7,
    max_tokens: int = 4096,
    stream: bool = False,
):
    """Call CLI Proxy API (OpenAI-compatible)."""
    if not CLI_PROXY_API_KEY:
        return None

    url = f"{CLI_PROXY_API_BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {CLI_PROXY_API_KEY}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream,
    }

    if stream:
        return await global_httpx_client.post(url, json=payload, headers=headers)
    else:
        response = await global_httpx_client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        return response.json()


async def _stream_cli_proxy_response(response, model_name):
    """
    Stream CLI Proxy API response in OpenAI format.
    """
    try:
        async for line in response.aiter_lines():
            if not line.strip():
                continue
            if line.startswith("data: "):
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    yield "data: [DONE]\n\n"
                    break

                yield f"data: {data_str}\n\n"
    except Exception as e:
        logger.error(f"Error during CLI Proxy streaming: {e}")
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
    finally:
        await response.aclose()


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    """OpenAI-compatible chat completion endpoint."""

    requested_model = request.model
    messages_payload = [
        {"role": m.role, "content": m.content} for m in request.messages
    ]

    # Log input size
    total_chars = sum(len(m.get("content", "") or "") for m in messages_payload)
    estimated_tokens = total_chars // 4
    logger.info(
        f"Chat request: model={requested_model}, messages={len(messages_payload)}, chars={total_chars}, est_tokens≈{estimated_tokens}"
    )

    # ==========================================
    # 2. Try SiliconFlow (Fallback 1)
    # ==========================================
    if SILICONFLOW_API_KEY and SILICONFLOW_BASE_URL:
        try:
            siliconflow_model = _resolve_provider_model(
                "SILICONFLOW_MODEL", requested_model
            )
            logger.info(f"Attempting SiliconFlow: Model={siliconflow_model}")
            if request.stream:
                sf_response = await _call_siliconflow(
                    messages_payload,
                    siliconflow_model,
                    request.temperature or 0.7,
                    request.max_tokens or 4095,
                    stream=True,
                )
                if sf_response.status_code == 200:
                    logger.info("✅ SiliconFlow (stream) succeeded")
                    return StreamingResponse(
                        _stream_siliconflow_response(sf_response, siliconflow_model),
                        media_type="text/event-stream",
                    )
                else:
                    error_body = await sf_response.aread()
                    logger.warning(
                        f"SiliconFlow failed with status {sf_response.status_code}: {error_body.decode()}"
                    )
                    await sf_response.aclose()
            else:
                sf_data = await _call_siliconflow(
                    messages_payload,
                    siliconflow_model,
                    request.temperature or 0.7,
                    request.max_tokens or 4095,
                    stream=False,
                )
                if sf_data:
                    logger.info("✅ SiliconFlow succeeded")
                    return sf_data
        except Exception as e:
            logger.error(f"SiliconFlow error: {e}")
            # Continue to CLI Proxy fallback

    # ==========================================
    # 5. Try CLI Proxy (Fallback 4)
    # ==========================================
    if CLI_PROXY_API_KEY and CLI_PROXY_MODELS:
        # Try models in CLI Proxy list
        all_cp_models = cli_proxy_model_manager.get_all()
        start_model = cli_proxy_model_manager.get_current()
        start_idx = all_cp_models.index(start_model)

        # We try all models starting from current index
        for i in range(len(all_cp_models)):
            current_idx = (start_idx + i) % len(all_cp_models)
            target_cp_model = all_cp_models[current_idx]

            try:
                logger.info(
                    f"Attempting CLI Proxy [{i + 1}/{len(all_cp_models)}]: Model={target_cp_model}"
                )
                if request.stream:
                    cp_response = await _call_cli_proxy(
                        messages_payload,
                        target_cp_model,
                        request.temperature or 0.7,
                        request.max_tokens or 4096,
                        stream=True,
                    )
                    if cp_response.status_code == 200:
                        logger.info(
                            f"✅ CLI Proxy (stream) succeeded with {target_cp_model}"
                        )
                        return StreamingResponse(
                            _stream_cli_proxy_response(cp_response, target_cp_model),
                            media_type="text/event-stream",
                        )
                    else:
                        error_body = await cp_response.aread()
                        logger.warning(
                            f"CLI Proxy model {target_cp_model} failed ({cp_response.status_code}): {error_body.decode()}"
                        )
                        await cp_response.aclose()
                        # If quota/rate limit, rotate and try next CLI Proxy model
                        if cp_response.status_code in [429, 402]:
                            cli_proxy_model_manager.rotate()
                            logger.info(
                                f"Rotated to next CLI Proxy model due to rate limit/quota"
                            )
                            continue
                        # Other error, move on to OpenRouter fallback entirely?
                        break
                else:
                    cp_data = await _call_cli_proxy(
                        messages_payload,
                        target_cp_model,
                        request.temperature or 0.7,
                        request.max_tokens or 4096,
                        stream=False,
                    )
                    if cp_data:
                        logger.info(f"✅ CLI Proxy succeeded with {target_cp_model}")
                        return cp_data
                    # If empty response, rotate and try next model
                    cli_proxy_model_manager.rotate()
            except Exception as e:
                logger.error(f"CLI Proxy error on {target_cp_model}: {e}")
                # Continue to next model or OpenRouter fallback

        # If we exhausted all CLI Proxy models
        logger.warning("All CLI Proxy models failed, moving to OpenRouter fallback")

    # ==========================================
    # 6. Try OpenRouter (Fallback 5)
    # ==========================================
    if OPENROUTER_API_KEY and OPENROUTER_BASE_URL:
        if not openrouter_usage_tracker.can_make_request():
            logger.warning("OpenRouter daily limit reached, skipping to next fallback")
        else:
            try:
                openrouter_model = _resolve_provider_model(
                    "OPENROUTER_MODEL", requested_model
                )
                logger.info(
                    f"Attempting OpenRouter: Model={openrouter_model} (Usage: {openrouter_usage_tracker.count + 1}/{openrouter_usage_tracker.limit})"
                )
                if request.stream:
                    or_response = await _call_openrouter(
                        messages_payload,
                        openrouter_model,
                        request.temperature or 0.7,
                        request.max_tokens or 4096,
                        stream=True,
                    )
                    if or_response.status_code == 200:
                        logger.info("✅ OpenRouter (stream) succeeded")
                        openrouter_usage_tracker.record_request()
                        return StreamingResponse(
                            _stream_openrouter_response(or_response, openrouter_model),
                            media_type="text/event-stream",
                        )
                    else:
                        error_body = await or_response.aread()
                        logger.warning(
                            f"OpenRouter failed with status {or_response.status_code}: {error_body.decode()}"
                        )
                        await or_response.aclose()
                else:
                    or_data = await _call_openrouter(
                        messages_payload,
                        openrouter_model,
                        request.temperature or 0.7,
                        request.max_tokens or 4096,
                        stream=False,
                    )
                    if or_data:
                        logger.info("✅ OpenRouter succeeded")
                        openrouter_usage_tracker.record_request()
                        return or_data
            except Exception as e:
                logger.error(f"OpenRouter error: {e}")

    # ==========================================
    # 3. Try Local LLM (Fallback 2)
    # ==========================================
    logger.info("Attempting Local LLM fallback...")
    try:
        local_response = await _call_local_llm_fallback(
            messages_payload, request.temperature, request.max_tokens
        )
        if local_response:
            logger.info(f"✅ Local LLM fallback succeeded")
            if request.stream:
                return StreamingResponse(
                    _stream_single_response(local_response),
                    media_type="text/event-stream",
                )
            return local_response
    except Exception as local_err:
        logger.error(f"Final fallback to Local LLM also failed: {local_err}")

    # If all else fails
    raise HTTPException(
        status_code=503,
        detail="All providers (SiliconFlow, CLI Proxy, OpenRouter, Local LLM) failed or are unavailable.",
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
