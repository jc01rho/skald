
import asyncio
import logging
import os
import time
import threading
import random
from datetime import date
from typing import Literal, Optional
import httpx
from groq import Groq, AsyncGroq

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

# Configuration
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3")
RERANK_MODEL = os.getenv("RERANK_MODEL", "xitao/bge-reranker-v2-m3:latest")
TARGET_DIMENSION = int(os.getenv("TARGET_DIMENSION", "768"))
EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "external")  # local, ollama, gemini, or external
RERANK_PROVIDER = os.getenv("RERANK_PROVIDER", "ollama")  # local (CrossEncoder), ollama
QUERY_LANGUAGE = os.getenv("QUERY_LANGUAGE", "ko")  # 한글 최적화 기본값
_ollama_url = os.getenv("LOCAL_LLM_BASE_URL", "http://localhost:11434")
# Remove /v1 suffix if present (Ollama native API doesn't use /v1)
OLLAMA_BASE_URL = _ollama_url.rstrip("/").removesuffix("/v1")
GROQ_API_KEYS_STR = os.getenv("GROQ_API_KEYS", "")
GROQ_API_KEYS = [k.strip() for k in GROQ_API_KEYS_STR.split(",") if k.strip()]
# OPENROUTER_API_KEY removed as per user request
# External embedding service URL (e.g., vLLM, TGI, or custom embedding server)
EXTERNAL_EMBEDDING_URL = os.getenv("EXTERNAL_EMBEDDING_URL", "http://192.168.150.37:8889/embeddings")

# Local LLM endpoints for fallback when Groq payload is too large
LOCAL_LLM_ENDPOINTS = [
    {
        "name": "kanana-local",
        "url": "http://192.168.150.37:8889/chat/completions",
        "type": "openai-compatible",  # Uses messages format directly
        "model": None,  # Not needed for this endpoint
    },
    {
        "name": "ollama-kanana",
        "url": "http://192.168.30.169:11434",
        "type": "ollama",
        "model": "cookieshake/kanana-1.5-8b-instruct-2505:Q4_K_M",
    },
]

print(f"Using embedding provider: {EMBEDDING_PROVIDER}")
print(f"Using rerank provider: {RERANK_PROVIDER}")
print(f"Using embedding model: {EMBEDDING_MODEL}")
print(f"Using rerank model: {RERANK_MODEL}")
print(f"Using target dimension: {TARGET_DIMENSION}")
print(f"Query language: {QUERY_LANGUAGE}")
if EMBEDDING_PROVIDER == "external":
    print(f"Using external embedding URL: {EXTERNAL_EMBEDDING_URL}")

# Thread-safe exhaustion-based round-robin API key management
import random
from datetime import datetime, date

class GroqKeyManager:
    """
    Thread-safe API key manager with exhaustion-based round-robin.
    Uses one key until it's exhausted (rate-limited/quota exceeded), 
    then switches to the next key.
    
    PROTECTION MECHANISMS for avoiding Organization Restriction:
    1. Permanent blocking for keys that get "organization restricted" errors
    2. Daily usage limits per key
    3. Conservative rate limiting
    """
    # Daily usage limit per key to avoid triggering organization restrictions
    DAILY_LIMIT_PER_KEY = 500  # Max requests per key per day
    
    def __init__(self, api_keys: list[str]):
        self._keys = api_keys
        self._current_index = 0  # Current active key index
        self._lock = threading.Lock()
        self._key_count = len(api_keys)
        # Track rate-limited keys: key -> cooldown_until timestamp
        self._rate_limited: dict[str, float] = {}
        # Track usage count per key for logging
        self._usage_count: dict[str, int] = {k: 0 for k in api_keys}
        # PROTECTION: Permanently blocked keys (organization restricted)
        self._permanently_blocked: set[str] = set()
        # PROTECTION: Daily usage tracking: key -> {date: count}
        self._daily_usage: dict[str, dict[str, int]] = {k: {} for k in api_keys}
        logger.info(f"Initialized GroqKeyManager with {self._key_count} keys (exhaustion-based round-robin with protection)")
        
    def _is_key_within_daily_limit(self, key: str) -> bool:
        """Check if key is within daily usage limit."""
        today = str(date.today())
        usage_today = self._daily_usage.get(key, {}).get(today, 0)
        return usage_today < self.DAILY_LIMIT_PER_KEY
    
    def _increment_daily_usage(self, key: str):
        """Increment daily usage counter for key."""
        today = str(date.today())
        if key not in self._daily_usage:
            self._daily_usage[key] = {}
        # Clean old dates (keep only today)
        self._daily_usage[key] = {today: self._daily_usage[key].get(today, 0) + 1}
    
    def get_current_key(self) -> tuple[str, int]:
        """
        Get the current active API key.
        Returns (api_key, key_index) tuple.
        Stays on the same key until it's marked as rate-limited or daily limit exceeded.
        """
        with self._lock:
            current_time = time.time()
            
            # Clean up expired rate limits
            expired_keys = [k for k, expire_time in self._rate_limited.items() 
                           if current_time >= expire_time]
            for k in expired_keys:
                del self._rate_limited[k]
                logger.info(f"API key [{self._keys.index(k) + 1}/{self._key_count}] cooldown expired, now available")
            
            # Check if current key is available
            current_key = self._keys[self._current_index]
            
            # PROTECTION: Skip permanently blocked keys
            if current_key in self._permanently_blocked:
                return self._find_available_key(current_time)
            
            # PROTECTION: Skip keys that exceeded daily limit
            if not self._is_key_within_daily_limit(current_key):
                logger.warning(f"API key [{self._current_index + 1}] exceeded daily limit ({self.DAILY_LIMIT_PER_KEY} requests). Blocking for 6 hours.")
                self.mark_rate_limited(current_key, cooldown_seconds=21600.0)
                return self._find_available_key(current_time)
            
            if current_key in self._rate_limited:
                # Current key is rate-limited, find next available key
                return self._find_available_key(current_time)
            
            # PROTECTION: Increment daily usage
            self._increment_daily_usage(current_key)
            self._usage_count[current_key] += 1
            return current_key, self._current_index
    
    def _find_available_key(self, current_time: float) -> tuple[str, int]:
        """
        Find the next available (non-rate-limited, non-permanently-blocked) key.
        Called when current key is exhausted.
        Must be called while holding the lock.
        """
        # Try to find an available key starting from current index
        for offset in range(self._key_count):
            idx = (self._current_index + offset) % self._key_count
            key = self._keys[idx]
            
            # PROTECTION: Skip permanently blocked keys
            if key in self._permanently_blocked:
                continue
                
            # PROTECTION: Skip keys that exceeded daily limit
            if not self._is_key_within_daily_limit(key):
                if key not in self._rate_limited:
                     self._rate_limited[key] = time.time() + 21600.0
                continue
            
            if key not in self._rate_limited:
                # Found an available key, switch to it
                old_index = self._current_index
                self._current_index = idx
                if offset > 0:
                    logger.info(f"Switched from key [{old_index + 1}] to key [{idx + 1}] (exhaustion-based rotation)")
                self._increment_daily_usage(key)
                self._usage_count[key] += 1
                return key, idx
        
        # All usable keys are rate-limited, find one with earliest expiry from non-blocked keys
        usable_rate_limited = {k: v for k, v in self._rate_limited.items() 
                               if k not in self._permanently_blocked and self._is_key_within_daily_limit(k)}
        
        if usable_rate_limited:
            earliest_key = min(usable_rate_limited, key=lambda k: usable_rate_limited[k])
            earliest_idx = self._keys.index(earliest_key)
            remaining_seconds = usable_rate_limited[earliest_key] - current_time
            logger.warning(f"All available keys rate-limited! Using key [{earliest_idx + 1}] (expires in {remaining_seconds:.1f}s)")
            self._increment_daily_usage(earliest_key)
            self._usage_count[earliest_key] += 1
            return earliest_key, earliest_idx
        
        # No keys available at all
        raise ValueError(f"All {self._key_count} API keys are either permanently blocked, rate-limited, or exceeded daily limit!")
    
    def mark_rate_limited(self, key: str, cooldown_seconds: float = 60.0):
        """
        Mark a key as rate-limited/exhausted for the specified duration.
        This triggers rotation to the next available key.
        """
        with self._lock:
            self._rate_limited[key] = time.time() + cooldown_seconds
            key_idx = self._keys.index(key)
            usage = self._usage_count.get(key, 0)
            logger.warning(f"API key [{key_idx + 1}/{self._key_count}] exhausted after {usage} uses, cooldown for {cooldown_seconds}s")
            
            # Reset usage count for this key
            self._usage_count[key] = 0
            
            # Try to switch to next available key
            current_time = time.time()
            available_count = sum(1 for k in self._keys 
                                  if k not in self._rate_limited 
                                  and k not in self._permanently_blocked
                                  and self._is_key_within_daily_limit(k))
            if available_count > 0:
                # Find next available key
                for offset in range(1, self._key_count):
                    next_idx = (self._current_index + offset) % self._key_count
                    next_key = self._keys[next_idx]
                    if (next_key not in self._rate_limited 
                        and next_key not in self._permanently_blocked
                        and self._is_key_within_daily_limit(next_key)):
                        self._current_index = next_idx
                        logger.info(f"Auto-rotated to key [{next_idx + 1}/{self._key_count}] ({available_count} usable keys remaining)")
                        break
            else:
                logger.error(f"All {self._key_count} API keys are now rate-limited, blocked, or exceeded daily limits!")
    
    def mark_permanently_blocked(self, key: str, reason: str = "organization_restricted"):
        """
        PROTECTION: Permanently block a key that received organization-level restriction.
        This key will not be used again until the service restarts.
        """
        with self._lock:
            if key not in self._permanently_blocked:
                self._permanently_blocked.add(key)
                key_idx = self._keys.index(key)
                logger.critical(f"🚨 API key [{key_idx + 1}/{self._key_count}] PERMANENTLY BLOCKED: {reason}")
                logger.critical(f"🚨 Remaining usable keys: {self._key_count - len(self._permanently_blocked)}")
                
                # Force rotation away from this key
                if self._current_index == key_idx:
                    for offset in range(1, self._key_count):
                        next_idx = (self._current_index + offset) % self._key_count
                        if self._keys[next_idx] not in self._permanently_blocked:
                            self._current_index = next_idx
                            logger.info(f"Force rotated to key [{next_idx + 1}] after permanent block")
                            break
    
    def get_key_count(self) -> int:
        return self._key_count
    
    def get_available_key_count(self) -> int:
        """Get the number of currently available (non-rate-limited) keys."""
        with self._lock:
            current_time = time.time()
            return sum(1 for k in self._keys 
                      if k not in self._rate_limited or current_time >= self._rate_limited[k])
    
    def get_status(self) -> dict:
        """Get detailed status of all keys for monitoring."""
        with self._lock:
            current_time = time.time()
            today = str(date.today())
            status = {
                "total_keys": self._key_count,
                "current_key_index": self._current_index + 1,
                "permanently_blocked_count": len(self._permanently_blocked),
                "daily_limit_per_key": self.DAILY_LIMIT_PER_KEY,
                "keys": []
            }
            for idx, key in enumerate(self._keys):
                daily_usage = self._daily_usage.get(key, {}).get(today, 0)
                key_status = {
                    "index": idx + 1,
                    "is_current": idx == self._current_index,
                    "usage_count": self._usage_count.get(key, 0),
                    "daily_usage": daily_usage,
                    "daily_remaining": max(0, self.DAILY_LIMIT_PER_KEY - daily_usage),
                    "is_rate_limited": key in self._rate_limited,
                    "is_permanently_blocked": key in self._permanently_blocked,
                }
                if key in self._rate_limited:
                    remaining = self._rate_limited[key] - current_time
                    key_status["cooldown_remaining_seconds"] = max(0, remaining)
                if key in self._permanently_blocked:
                    key_status["block_reason"] = "organization_restricted"
                status["keys"].append(key_status)
    def get_all_keys(self) -> list[str]:
        """Return all managed keys for manual iteration."""
        return self._keys



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
        """Activate the cooldown period."""
        with self._lock:
            self._cooldown_until = time.time() + self._cooldown_duration
            logger.error(f"Dimension error detected! Embedding service entering {self._cooldown_duration/60:.0f} minute cooldown.")


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

# Initialize managers
# Initialize managers
groq_key_manager: GroqKeyManager | None = None
dimension_error_cooldown = DimensionErrorCooldown(cooldown_seconds=3600.0)  # 1 hour

# Initialize Groq Manager if keys are present
if GROQ_API_KEYS:
    groq_key_manager = GroqKeyManager(GROQ_API_KEYS)
    print(f"Groq API configured with {len(GROQ_API_KEYS)} keys (thread-safe round-robin)")
else:
    logger.warning("GROQ_API_KEY is not set. Groq features (chat) will not work.")

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


# ============================================================
# 한글 최적화 함수들
# ============================================================

def preprocess_korean_query(query: str) -> str:
    """
    한글 쿼리 전처리 함수
    - 불필요한 공백 제거
    - 조사 처리 (간단한 정규화)
    """
    import re
    
    # 중복 공백 제거
    query = re.sub(r'\s+', ' ', query.strip())
    
    # 한글 쿼리인 경우 특수 처리
    if is_korean_text(query):
        # 일반적인 조사들을 공백으로 변환하여 검색 품질 향상
        # (완전히 제거하지 않고 공백으로 대체)
        pass  # 조사 제거는 오히려 의미를 해칠 수 있으므로 현재는 비활성화
    
    return query


def is_korean_text(text: str) -> bool:
    """텍스트가 한글을 포함하는지 확인"""
    import re
    korean_pattern = re.compile(r'[가-힣]')
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
                json={"model": EMBEDDING_MODEL, "prompt": text}
            )
            response.raise_for_status()
            data = response.json()
            return data["embedding"]
        except httpx.HTTPStatusError as e:
            logger.error(f"Ollama API error: {e.response.status_code} - {e.response.text}")
            raise HTTPException(status_code=502, detail=f"Ollama API error: {str(e)}")
        except Exception as e:
            logger.error(f"Failed to get embedding from Ollama: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Ollama connection failed: {str(e)}")


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
                json={
                    "model": EMBEDDING_MODEL,
                    "input": text
                },
                headers={"Content-Type": "application/json"}
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
                embedding = data["embeddings"][0] if isinstance(data["embeddings"][0], list) else data["embeddings"]
            else:
                logger.error(f"Unexpected response format from external embedding service: {data.keys()}")
                raise HTTPException(status_code=500, detail=f"Unexpected response format: {data.keys()}")
            
            logger.debug(f"Got embedding from external service, dimension: {len(embedding)}")
            return embedding
            
        except httpx.HTTPStatusError as e:
            logger.error(f"External embedding API error: {e.response.status_code} - {e.response.text}")
            raise HTTPException(status_code=502, detail=f"External embedding API error: {str(e)}")
        except Exception as e:
            logger.error(f"Failed to get embedding from external service: {str(e)}")
            raise HTTPException(status_code=500, detail=f"External embedding connection failed: {str(e)}")


def _gemini_call(text: str, api_key: str, model: str, task_type: str = "retrieval_document", key_index: int = 0, total_keys: int = 1) -> list[float]:
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
            output_dimensionality=TARGET_DIMENSION
        )
    except TypeError:
        # output_dimensionality 파라미터를 지원하지 않는 경우 (구버전 라이브러리 등)
        logger.warning(f"Model {model} does not support output_dimensionality parameter, falling back to default")
        result = genai.embed_content(
            model=model,
            content=text,
            task_type=task_type
        )
    
    embedding = result['embedding']
    
    # Log dimension info for debugging (MRL truncation happens in normalize_embedding)
    if len(embedding) != TARGET_DIMENSION:
        logger.debug(f"Gemini embedding dimension {len(embedding)} will be normalized to {TARGET_DIMENSION} via MRL truncation")
        
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
                gemini_key_manager.get_key_count()
            )
        except ValueError as e:
            # Dimension mismatch error - activate 1 hour cooldown
            error_str = str(e)
            if "dimension" in error_str.lower() and "exceeds" in error_str.lower():
                dimension_error_cooldown.activate_cooldown()
                raise HTTPException(
                    status_code=503, 
                    detail=f"Dimension error detected. Service entering 1-hour cooldown. Error: {error_str}"
                )
            raise HTTPException(status_code=500, detail=f"Gemini API error: {error_str}")
        except Exception as e:
            error_str = str(e)
            last_error = e
            
            # Check for rate limit (429) or quota exceeded errors
            is_rate_limit = (
                "429" in error_str or 
                "rate" in error_str.lower() or 
                "quota" in error_str.lower() or
                "resource_exhausted" in error_str.lower()
            )
            
            if is_rate_limit:
                # Mark this key as rate-limited and try next key
                gemini_key_manager.mark_rate_limited(current_key, cooldown_seconds=60.0)
                logger.warning(f"Rate limit hit on key [{key_index + 1}/{gemini_key_manager.get_key_count()}], trying next key (attempt {attempt + 1}/{max_retries})")
                continue
            else:
                # Non-rate-limit error, don't retry
                logger.error(f"Failed to get embedding from Gemini: {error_str}")
                raise HTTPException(status_code=500, detail=f"Gemini API error: {error_str}")
    
    # All retries exhausted
    logger.error(f"All {max_retries} API keys exhausted due to rate limiting")
    raise HTTPException(
        status_code=429, 
        detail=f"All API keys rate-limited. Please try again later. Last error: {str(last_error)}"
    )


async def get_ollama_rerank_embedding(text: str) -> list[float]:
    """Get embedding from Ollama API using the rerank model"""
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.post(
                f"{OLLAMA_BASE_URL}/api/embeddings",
                json={"model": RERANK_MODEL, "prompt": text}
            )
            response.raise_for_status()
            data = response.json()
            return data["embedding"]
        except httpx.HTTPStatusError as e:
            logger.error(f"Ollama rerank API error: {e.response.status_code} - {e.response.text}")
            raise HTTPException(status_code=502, detail=f"Ollama rerank API error: {str(e)}")
        except Exception as e:
            logger.error(f"Failed to get rerank embedding from Ollama: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Ollama rerank connection failed: {str(e)}")


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

async def rerank_with_ollama(query: str, documents: list[str]) -> list[tuple[int, float]]:
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


def _rerank_with_crossencoder(query: str, documents: list[str]) -> list[tuple[int, float]]:
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
    indexed_scores = [(idx, float(score)) for idx, score in enumerate(normalized_scores)]
    
    # 점수 기준 내림차순 정렬
    indexed_scores.sort(key=lambda x: x[1], reverse=True)
    
    return indexed_scores


async def rerank_with_local_crossencoder(query: str, documents: list[str]) -> list[tuple[int, float]]:
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
        default="storage", description="Usage type: 'storage' for documents, 'search' for queries"
    )


class EmbedResponse(BaseModel):
    embedding: list[float] = Field(..., description="The generated embedding vector")
    dimension: int = Field(..., description="Dimension of the embedding vector")


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
        usage = request.usage if hasattr(request, 'usage') else "storage"
        
        if EMBEDDING_PROVIDER == "ollama":
            embedding = await get_ollama_embedding(request.content)
        elif EMBEDDING_PROVIDER == "external":
            # 한글 쿼리 전처리
            processed_content = preprocess_korean_query(request.content) if usage == "search" else request.content
            embedding = await get_external_embedding(processed_content)
        elif EMBEDDING_PROVIDER == "local":
            if embedding_model is None:
                raise HTTPException(status_code=503, detail="Local embedding model not available")
            # 한글 쿼리 전처리
            processed_content = preprocess_korean_query(request.content) if usage == "search" else request.content
            embedding = embedding_model.encode(processed_content).tolist()
        else:
            raise HTTPException(status_code=501, detail=f"Provider {EMBEDDING_PROVIDER} not implemented")

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
    logger.debug(f"Rerank request received: query length={len(request.query)}, documents count={len(request.documents)}, top_k={request.top_k}")
    
    try:
        check_start = time.perf_counter()
        if not request.documents:
            logger.debug(f"Empty documents list, returning empty results (took {time.perf_counter() - check_start:.6f}s)")
            return RerankResponse(results=[])
        logger.debug(f"Documents check completed (took {time.perf_counter() - check_start:.6f}s)")

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
            logger.debug(f"CrossEncoder rerank completed (took {time.perf_counter() - crossencoder_start:.6f}s)")
            
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
                reranked = reranked[:request.top_k]
            
            total_time = time.perf_counter() - start_time
            logger.debug(f"Rerank completed successfully: returning {len(reranked)} results (total time: {total_time:.6f}s)")
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
            logger.debug(f"Ollama rerank completed (took {time.perf_counter() - ollama_start:.6f}s)")
            
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
                reranked = reranked[:request.top_k]
            
            total_time = time.perf_counter() - start_time
            logger.debug(f"Rerank completed successfully: returning {len(reranked)} results (total time: {total_time:.6f}s)")
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
                reranked = reranked[:request.top_k]
            return RerankResponse(results=reranked)

    except Exception as e:
        total_time = time.perf_counter() - start_time
        logger.error(f"Rerank failed after {total_time:.6f}s: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Reranking failed: {str(e)}")


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
    """
    Test all configured Groq API keys to check if they are valid or blocked.
    WARNING: This consumes a small amount of quota for each key.
    """
    if not groq_key_manager:
        raise HTTPException(status_code=503, detail="Groq API keys not configured")
        
    all_keys = groq_key_manager.get_all_keys()
    results = []
    
    # Simple test payload
    messages = [{"role": "user", "content": "ping"}]
    
    for key in all_keys:
        key_mask = f"{key[:4]}...{key[-4:]}" if len(key) > 8 else "***"
        result = KeyValidationResult(key_mask=key_mask, is_valid=False)
        
        try:
            # Create a localized client for this key
            client = AsyncGroq(api_key=key, max_retries=0)
            
            # Use a fast, cheap model for testing
            await client.chat.completions.create(
                model="llama-3.1-8b-instant",
                messages=messages,
                max_completion_tokens=1
            )
            result.is_valid = True
            result.status_code = 200
        except Exception as e:
            error_str = str(e)
            result.error_message = error_str
            
            # Extract status code if available in error object or string
            if hasattr(e, "status_code"):
                result.status_code = e.status_code
            elif "401" in error_str:
                result.status_code = 401
            elif "429" in error_str:
                result.status_code = 429
            elif "404" in error_str:
                result.status_code = 404
            else:
                result.status_code = 500
            
        results.append(result)
        
    return {
        "total_keys": len(all_keys),
        "valid_keys_count": sum(1 for r in results if r.is_valid),
        "blocked_keys_count": sum(1 for r in results if not r.is_valid),
        "details": results
    }

@app.get("/info")
async def get_info():
    """서비스 정보 및 현재 설정 반환"""
    return {
        "service": "Embedding Service",
        "version": "1.1.0",
        "features": {
            "korean_optimization": True,
            "crossencoder_reranking": RERANK_PROVIDER == "local" and rerank_model is not None,
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
            "embedding_model": embedding_model is not None if EMBEDDING_PROVIDER == "local" else "external",
            "rerank_model": rerank_model is not None,
        }
    }


@app.get("/api-keys/status")
async def get_api_keys_status():
    """
    Get the status of Groq API keys for monitoring.
    Shows usage counts, rate-limit status, and cooldown times.
    """
    if groq_key_manager is None:
        return {
            "provider": EMBEDDING_PROVIDER,
            "message": "Groq API key management not active",
            "keys": None
        }
    
    return {
        "provider": EMBEDDING_PROVIDER,
        "strategy": "exhaustion-based round-robin",
        "status": groq_key_manager.get_status(),
        "available_keys": groq_key_manager.get_available_key_count(),
    }


# ============================================================
# Chat Proxy (Groq Round-Robin)
# ============================================================


# Groq Official Model Limits (as of 2024-12)
# RPM: Requests per Minute, RPD: Requests per Day
# TPM: Tokens per Minute, TPD: Tokens per Day
GROQ_MODEL_LIMITS = {
    "allam-2-7b": {"rpm": 30, "rpd": 7000, "tpm": 6000, "tpd": 500000},
    "groq/compound": {"rpm": 30, "rpd": 250, "tpm": 70000, "tpd": None},  # No limit
    "groq/compound-mini": {"rpm": 30, "rpd": 250, "tpm": 70000, "tpd": None},
    "llama-3.1-8b-instant": {"rpm": 30, "rpd": 14400, "tpm": 6000, "tpd": 500000},
    "llama-3.3-70b-versatile": {"rpm": 30, "rpd": 1000, "tpm": 12000, "tpd": 100000},
    "meta-llama/llama-4-maverick-17b-128e-instruct": {"rpm": 30, "rpd": 1000, "tpm": 6000, "tpd": 500000},
    "meta-llama/llama-4-scout-17b-16e-instruct": {"rpm": 30, "rpd": 1000, "tpm": 30000, "tpd": 500000},
    "meta-llama/llama-guard-4-12b": {"rpm": 30, "rpd": 14400, "tpm": 15000, "tpd": 500000},
    "meta-llama/llama-prompt-guard-2-22m": {"rpm": 30, "rpd": 14400, "tpm": 15000, "tpd": 500000},
    "meta-llama/llama-prompt-guard-2-86m": {"rpm": 30, "rpd": 14400, "tpm": 15000, "tpd": 500000},
    "moonshotai/kimi-k2-instruct": {"rpm": 60, "rpd": 1000, "tpm": 10000, "tpd": 300000},
    "moonshotai/kimi-k2-instruct-0905": {"rpm": 60, "rpd": 1000, "tpm": 10000, "tpd": 300000},
    "openai/gpt-oss-120b": {"rpm": 30, "rpd": 1000, "tpm": 8000, "tpd": 200000},
    "openai/gpt-oss-20b": {"rpm": 30, "rpd": 1000, "tpm": 8000, "tpd": 200000},
    "openai/gpt-oss-safeguard-20b": {"rpm": 30, "rpd": 1000, "tpm": 8000, "tpd": 200000},
    "qwen/qwen3-32b": {"rpm": 60, "rpd": 1000, "tpm": 6000, "tpd": 500000},
}

# Default limits for unknown models
DEFAULT_MODEL_LIMITS = {"rpm": 30, "rpd": 1000, "tpm": 6000, "tpd": 100000}

# PROTECTION: Minimum delay between requests (seconds) + random jitter
MIN_REQUEST_DELAY = 5.0  # Base minimum delay (reduced from 10s for better responsiveness)
MAX_JITTER = 3.0  # Additional random delay (0 to MAX_JITTER)

# Preemptive thresholds (percentage of limit before entering preemptive cooldown)
PREEMPTIVE_RPD_THRESHOLD = 0.80  # 80% of daily request limit
PREEMPTIVE_TPD_THRESHOLD = 0.80  # 80% of daily token limit


class KeyHealthTracker:
    """
    Tracks API key health based on success/error rates.
    Prioritizes healthier keys for better reliability.
    """
    def __init__(self):
        self._lock = threading.Lock()
        # {key: {"success": int, "error": int, "last_error_time": float, "score": float}}
        self._health_data: dict[str, dict] = {}
        self._window_size = 100  # Track last N requests for scoring
    
    def record_success(self, key: str):
        """Record a successful request for this key."""
        with self._lock:
            if key not in self._health_data:
                self._health_data[key] = {"success": 0, "error": 0, "last_error_time": 0, "score": 1.0}
            self._health_data[key]["success"] += 1
            self._update_score(key)
    
    def record_error(self, key: str, error_type: str = "unknown"):
        """Record an error for this key."""
        with self._lock:
            if key not in self._health_data:
                self._health_data[key] = {"success": 0, "error": 0, "last_error_time": 0, "score": 1.0}
            self._health_data[key]["error"] += 1
            self._health_data[key]["last_error_time"] = time.time()
            self._health_data[key]["last_error_type"] = error_type
            self._update_score(key)
    
    def _update_score(self, key: str):
        """Update health score based on success/error ratio."""
        data = self._health_data[key]
        total = data["success"] + data["error"]
        if total == 0:
            data["score"] = 1.0
            return
        
        # Base score from success rate
        success_rate = data["success"] / total
        
        # Decay factor based on recency of last error
        time_since_error = time.time() - data["last_error_time"]
        decay = min(1.0, time_since_error / 3600)  # Full recovery after 1 hour
        
        # Combined score
        data["score"] = success_rate * 0.7 + decay * 0.3
    
    def get_score(self, key: str) -> float:
        """Get health score for a key (0.0 to 1.0)."""
        with self._lock:
            if key not in self._health_data:
                return 1.0  # Unknown keys start with perfect score
            return self._health_data[key]["score"]
    
    def get_healthiest_keys(self, keys: list[str]) -> list[str]:
        """Return keys sorted by health score (healthiest first)."""
        with self._lock:
            return sorted(keys, key=lambda k: self._health_data.get(k, {}).get("score", 1.0), reverse=True)
    
    def get_status(self) -> dict:
        """Get health status for all tracked keys."""
        with self._lock:
            return {
                k[:8] + "...": {
                    "score": round(v["score"], 3),
                    "success": v["success"],
                    "error": v["error"]
                }
                for k, v in self._health_data.items()
            }


class TokenBudgetManager:
    """
    Tracks token usage per (key, model) pair for budget management.
    Provides preemptive warnings when approaching limits.
    """
    def __init__(self):
        self._lock = threading.Lock()
        # {(key, model): {"tpm_usage": [], "tpd_usage": int, "rpd_usage": int, "last_reset": date}}
        self._usage: dict[tuple[str, str], dict] = {}
    
    def _get_or_create(self, key: str, model: str) -> dict:
        """Get or create usage tracking for (key, model) pair."""
        key_model = (key, model)
        if key_model not in self._usage:
            self._usage[key_model] = {
                "tpm_window": [],  # [(timestamp, tokens), ...]
                "tpd_usage": 0,
                "rpd_usage": 0,
                "last_reset_date": str(date.today())
            }
        
        # Reset daily counters if new day
        today = str(date.today())
        if self._usage[key_model]["last_reset_date"] != today:
            self._usage[key_model]["tpd_usage"] = 0
            self._usage[key_model]["rpd_usage"] = 0
            self._usage[key_model]["last_reset_date"] = today
        
        return self._usage[key_model]
    
    def record_usage(self, key: str, model: str, tokens: int):
        """Record token usage for a request."""
        with self._lock:
            usage = self._get_or_create(key, model)
            now = time.time()
            
            # Add to TPM window
            usage["tpm_window"].append((now, tokens))
            
            # Clean old entries (older than 60 seconds)
            usage["tpm_window"] = [(t, tok) for t, tok in usage["tpm_window"] if now - t < 60]
            
            # Update daily counters
            usage["tpd_usage"] += tokens
            usage["rpd_usage"] += 1
    
    def get_tpm_usage(self, key: str, model: str) -> int:
        """Get current tokens per minute usage."""
        with self._lock:
            usage = self._get_or_create(key, model)
            now = time.time()
            # Clean and sum
            usage["tpm_window"] = [(t, tok) for t, tok in usage["tpm_window"] if now - t < 60]
            return sum(tok for _, tok in usage["tpm_window"])
    
    def check_limits(self, key: str, model: str, estimated_tokens: int) -> tuple[bool, str]:
        """
        Check if making a request would exceed limits.
        Returns (is_ok, message).
        """
        with self._lock:
            usage = self._get_or_create(key, model)
            limits = GROQ_MODEL_LIMITS.get(model, DEFAULT_MODEL_LIMITS)
            
            # Check TPM
            current_tpm = sum(tok for _, tok in usage["tpm_window"] if time.time() - _[0] < 60)
            if current_tpm + estimated_tokens > limits["tpm"]:
                return False, f"TPM limit ({limits['tpm']}) would be exceeded"
            
            # Check TPD
            if limits["tpd"] and usage["tpd_usage"] + estimated_tokens > limits["tpd"]:
                return False, f"TPD limit ({limits['tpd']}) would be exceeded"
            
            # Check RPD
            if usage["rpd_usage"] + 1 > limits["rpd"]:
                return False, f"RPD limit ({limits['rpd']}) would be exceeded"
            
            return True, "OK"
    
    def is_approaching_limit(self, key: str, model: str) -> tuple[bool, str]:
        """Check if approaching daily limits (preemptive warning)."""
        with self._lock:
            usage = self._get_or_create(key, model)
            limits = GROQ_MODEL_LIMITS.get(model, DEFAULT_MODEL_LIMITS)
            
            # Check RPD preemptive threshold
            if usage["rpd_usage"] > limits["rpd"] * PREEMPTIVE_RPD_THRESHOLD:
                pct = usage["rpd_usage"] / limits["rpd"] * 100
                return True, f"RPD at {pct:.1f}% ({usage['rpd_usage']}/{limits['rpd']})"
            
            # Check TPD preemptive threshold
            if limits["tpd"] and usage["tpd_usage"] > limits["tpd"] * PREEMPTIVE_TPD_THRESHOLD:
                pct = usage["tpd_usage"] / limits["tpd"] * 100
                return True, f"TPD at {pct:.1f}% ({usage['tpd_usage']}/{limits['tpd']})"
            
            return False, "OK"
    
    def get_status(self, key: str = None) -> dict:
        """Get usage status for monitoring."""
        with self._lock:
            result = {}
            for (k, m), usage in self._usage.items():
                if key and k != key:
                    continue
                limits = GROQ_MODEL_LIMITS.get(m, DEFAULT_MODEL_LIMITS)
                key_prefix = k[:8] + "..."
                if key_prefix not in result:
                    result[key_prefix] = {}
                result[key_prefix][m] = {
                    "rpd": f"{usage['rpd_usage']}/{limits['rpd']}",
                    "tpd": f"{usage['tpd_usage']}/{limits['tpd'] or 'unlimited'}",
                }
            return result


class AdaptiveThrottler:
    """
    Adaptive rate limiting based on recent error rates.
    Automatically increases delays when seeing many errors.
    """
    def __init__(self):
        self._lock = threading.Lock()
        self._recent_errors: list[float] = []  # Timestamps of recent errors
        self._recent_requests: list[float] = []  # Timestamps of recent requests
        self._window = 300.0  # 5 minute window
        self._base_delay = MIN_REQUEST_DELAY
        self._max_multiplier = 5.0  # Maximum delay multiplier
    
    def record_request(self):
        """Record a request attempt."""
        with self._lock:
            now = time.time()
            self._recent_requests.append(now)
            self._clean_old_entries(now)
    
    def record_error(self):
        """Record an error."""
        with self._lock:
            now = time.time()
            self._recent_errors.append(now)
            self._clean_old_entries(now)
    
    def _clean_old_entries(self, now: float):
        """Remove entries older than window."""
        self._recent_errors = [t for t in self._recent_errors if now - t < self._window]
        self._recent_requests = [t for t in self._recent_requests if now - t < self._window]
    
    def get_delay_multiplier(self) -> float:
        """Get delay multiplier based on error rate."""
        with self._lock:
            now = time.time()
            self._clean_old_entries(now)
            
            if len(self._recent_requests) < 5:
                return 1.0  # Not enough data
            
            error_rate = len(self._recent_errors) / len(self._recent_requests)
            
            # Scale multiplier based on error rate
            # 0% errors -> 1.0x, 50% errors -> 3.0x, 100% errors -> 5.0x
            multiplier = 1.0 + (self._max_multiplier - 1.0) * min(1.0, error_rate * 2)
            return multiplier
    
    def get_recommended_delay(self) -> float:
        """Get recommended delay before next request."""
        multiplier = self.get_delay_multiplier()
        jitter = random.uniform(0, MAX_JITTER)
        return self._base_delay * multiplier + jitter
    
    def get_status(self) -> dict:
        """Get throttler status."""
        with self._lock:
            now = time.time()
            self._clean_old_entries(now)
            req_count = len(self._recent_requests)
            err_count = len(self._recent_errors)
            return {
                "window_seconds": self._window,
                "recent_requests": req_count,
                "recent_errors": err_count,
                "error_rate": round(err_count / req_count, 3) if req_count > 0 else 0,
                "delay_multiplier": round(self.get_delay_multiplier(), 2),
                "recommended_delay": round(self.get_recommended_delay(), 2)
            }


class ResponseCache:
    """
    Simple LRU cache for LLM responses.
    Caches based on message content hash.
    """
    def __init__(self, max_size: int = 100, ttl_seconds: float = 3600):
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[dict, float]] = {}  # {hash: (response, timestamp)}
        self._max_size = max_size
        self._ttl = ttl_seconds
        self._hits = 0
        self._misses = 0
    
    def _hash_messages(self, messages: list[dict], model: str) -> str:
        """Create a hash key from messages and model."""
        import hashlib
        content = json.dumps({"messages": messages, "model": model}, sort_keys=True)
        return hashlib.md5(content.encode()).hexdigest()
    
    def get(self, messages: list[dict], model: str) -> dict | None:
        """Try to get a cached response."""
        with self._lock:
            key = self._hash_messages(messages, model)
            if key in self._cache:
                response, timestamp = self._cache[key]
                if time.time() - timestamp < self._ttl:
                    self._hits += 1
                    logger.debug(f"Cache HIT for request (hits={self._hits})")
                    return response
                else:
                    # Expired
                    del self._cache[key]
            self._misses += 1
            return None
    
    def set(self, messages: list[dict], model: str, response: dict):
        """Cache a response."""
        with self._lock:
            key = self._hash_messages(messages, model)
            
            # Evict oldest if at capacity
            if len(self._cache) >= self._max_size:
                oldest_key = min(self._cache, key=lambda k: self._cache[k][1])
                del self._cache[oldest_key]
            
            self._cache[key] = (response, time.time())
    
    def get_status(self) -> dict:
        """Get cache statistics."""
        with self._lock:
            total = self._hits + self._misses
            return {
                "size": len(self._cache),
                "max_size": self._max_size,
                "hits": self._hits,
                "misses": self._misses,
                "hit_rate": round(self._hits / total, 3) if total > 0 else 0,
                "ttl_seconds": self._ttl
            }


# Initialize all managers
key_health_tracker = KeyHealthTracker()
token_budget_manager = TokenBudgetManager()
adaptive_throttler = AdaptiveThrottler()
response_cache = ResponseCache(max_size=200, ttl_seconds=1800)  # 30 min TTL


class GroqRateLimiter:
    """
    Rate limiter with Key+Model level Cooldown management.
    Supports Running (120s) and Cooldown (180s) cycle per (key, model) pair.
    """
    # Cooldown duration for (key, model) pairs after running period expires
    KEY_MODEL_COOLDOWN_DURATION = 180.0  # 180 seconds cooldown
    KEY_MODEL_RUNNING_DURATION = 120.0   # 120 seconds running window
    ERROR_COOLDOWN_DURATION = 900.0      # 15 minutes (900 seconds) for 429/413 errors
    DAILY_LIMIT_COOLDOWN_DURATION = 21600.0  # 6 hours for daily limit exceeded
    
    def __init__(self):
        self._last_request_times = {} # {key: {model: timestamp}}
        self._blocked_until = {} # {(key, model): timestamp_when_available}
        self._global_block_until = 0.0
        self._lock = asyncio.Lock()
        # Track (key, model) cycle: {(key, model): {"cycle_start": timestamp, "state": "RUNNING"|"COOLDOWN"}}
        self._key_model_cycle = {}
    
    def get_wait_time(self, key: str, model: str) -> float:
        # First check if specifically blocked due to recent 429
        if self.is_blocked(key, model):
            return 999.0 # Arbitrary large number to signal block

        # Get RPM from new limits structure
        limits = GROQ_MODEL_LIMITS.get(model, DEFAULT_MODEL_LIMITS)
        rpm = limits["rpm"]
        interval = 60.0 / rpm
        
        # Check last request time
        key_usage = self._last_request_times.get(key, {})
        last_time = key_usage.get(model, 0)
        now = time.time()
        
        elapsed = now - last_time
        if elapsed < interval:
            return interval - elapsed
        return 0.0

    def is_blocked(self, key: str, model: str) -> bool:
        """Check if this (key, model) is currently in penalty box due to 429"""
        unlock_time = self._blocked_until.get((key, model), 0)
        return time.time() < unlock_time
    
    def is_in_cooldown(self, key: str, model: str) -> tuple[bool, float]:
        """
        Check if (key, model) is in cooldown state based on Running/Cooldown cycle.
        Returns (is_in_cooldown, remaining_seconds).
        
        Cycle: Running (120s) -> Cooldown (180s) -> Running ...
        """
        now = time.time()
        key_model = (key, model)
        
        if key_model not in self._key_model_cycle:
            # No cycle started yet, start a new one
            self._key_model_cycle[key_model] = {
                "cycle_start": now,
                "state": "RUNNING"
            }
            return False, 0.0
        
        cycle = self._key_model_cycle[key_model]
        elapsed = now - cycle["cycle_start"]
        
        if cycle["state"] == "RUNNING":
            if elapsed > self.KEY_MODEL_RUNNING_DURATION:
                # Running time exceeded, enter cooldown
                cycle["state"] = "COOLDOWN"
                cycle["cycle_start"] = now
                logger.warning(f"Key+Model [{key[:8]}..., {model}] running period ({self.KEY_MODEL_RUNNING_DURATION}s) ended. Entering COOLDOWN for {self.KEY_MODEL_COOLDOWN_DURATION}s")
                return True, self.KEY_MODEL_COOLDOWN_DURATION
            return False, 0.0
        
        elif cycle["state"] == "COOLDOWN":
            if elapsed > self.KEY_MODEL_COOLDOWN_DURATION:
                # Cooldown finished, back to running
                cycle["state"] = "RUNNING"
                cycle["cycle_start"] = now
                logger.info(f"Key+Model [{key[:8]}..., {model}] cooldown finished. Starting NEW running cycle.")
                return False, 0.0
            remaining = self.KEY_MODEL_COOLDOWN_DURATION - elapsed
            return True, remaining
        
        return False, 0.0
    
    def get_any_key_model_in_cooldown(self) -> list[tuple[str, str, float]]:
        """
        Get all (key, model) pairs currently in cooldown state.
        Returns list of (key, model, remaining_seconds).
        """
        now = time.time()
        in_cooldown = []
        
        for (key, model), cycle in self._key_model_cycle.items():
            if cycle["state"] == "COOLDOWN":
                elapsed = now - cycle["cycle_start"]
                if elapsed < self.KEY_MODEL_COOLDOWN_DURATION:
                    remaining = self.KEY_MODEL_COOLDOWN_DURATION - elapsed
                    in_cooldown.append((key, model, remaining))
        
        return in_cooldown

    def is_globally_blocked(self) -> tuple[bool, float]:
        """Check if global block is active"""
        now = time.time()
        if now < self._global_block_until:
            return True, self._global_block_until - now
        return False, 0.0

    async def block_key_model(self, key: str, model: str, duration: float = 900.0):
        """
        Put this (key, model) in penalty box.
        Default duration: 900 seconds (15 minutes) for errors.
        """
        async with self._lock:
            self._blocked_until[(key, model)] = time.time() + duration
            logger.warning(f"Blocked (key={key[:8]}..., model={model}) for {duration}s")

    async def block_key_model_daily_limit(self, key: str, model: str):
        """Block (key, model) for 6 hours due to daily limit exceeded."""
        await self.block_key_model(key, model, duration=self.DAILY_LIMIT_COOLDOWN_DURATION)
        logger.warning(f"Daily limit exceeded for (key={key[:8]}..., model={model}). Blocked for 6 hours.")

    async def activate_global_block(self, duration: float = 300.0):
        """Block ALL Groq requests for 'duration' seconds"""
        async with self._lock:
            self._global_block_until = time.time() + duration
            logger.error(f"Global Rate Limit triggered! Blocking ALL Groq requests for {duration} seconds.")

    async def update_request_time(self, key: str, model: str):
        async with self._lock:
            if key not in self._last_request_times:
                self._last_request_times[key] = {}
            self._last_request_times[key][model] = time.time()

    def get_status(self):
        now = time.time()
        blocked_status = []
        for (key, model), unlock_time in self._blocked_until.items():
            if now < unlock_time:
                remaining = unlock_time - now
                blocked_status.append({
                    "key_prefix": key[:8] + "...",
                    "model": model,
                    "remaining_seconds": round(remaining, 1)
                })
        
        # Add key+model cooldown status
        cooldown_status = []
        for (key, model), cycle in self._key_model_cycle.items():
            if cycle["state"] == "COOLDOWN":
                elapsed = now - cycle["cycle_start"]
                if elapsed < self.KEY_MODEL_COOLDOWN_DURATION:
                    remaining = self.KEY_MODEL_COOLDOWN_DURATION - elapsed
                    cooldown_status.append({
                        "key_prefix": key[:8] + "...",
                        "model": model,
                        "remaining_seconds": round(remaining, 1),
                        "type": "cycle_cooldown"
                    })
        
        remaining_global = max(0.0, self._global_block_until - now)
        
        return {
            "global_block_remaining": round(remaining_global, 1),
            "blocked_keys": blocked_status,
            "cycle_cooldowns": cooldown_status,
            "total_blocked": len(blocked_status),
            "total_in_cooldown_cycle": len(cooldown_status)
        }

groq_rate_limiter = GroqRateLimiter()

# Model fallback chains (Primary -> [Fallbacks])
GROQ_MODEL_FALLBACKS = {
    # High Intelligence / Chat Tier
    "llama-3.3-70b-versatile": [
        "llama-3.3-70b-versatile", 
        "qwen/qwen3-32b", 
        "moonshotai/kimi-k2-instruct", # 60 RPM
# Fallback to Fast Tier if High Tier is exhausted
        "openai/gpt-oss-120b", 
        "groq/compound",
        "llama-3.1-8b-instant", 
        "moonshotai/kimi-k2-instruct-0905",
        "meta-llama/llama-4-scout-17b-16e-instruct",
        "meta-llama/llama-4-maverick-17b-128e-instruct",
        "openai/gpt-oss-20b", 
        "openai/gpt-oss-safeguard-20b",
        "allam-2-7b", 
        "groq/compound-mini",
    ],
    
    # Fast / Classification Tier
    "llama-3.1-8b-instant": [
        "openai/gpt-oss-120b", 
        "groq/compound",
        "llama-3.1-8b-instant", 
        "moonshotai/kimi-k2-instruct-0905", # 60 RPM
        "meta-llama/llama-4-scout-17b-16e-instruct", # 30 RPM, 30k TPM
        "meta-llama/llama-4-maverick-17b-128e-instruct", # 30 RPM
        "openai/gpt-oss-20b", 
        "openai/gpt-oss-safeguard-20b",
        "allam-2-7b", 
        "groq/compound-mini",
        "meta-llama/llama-guard-4-12b",
        "meta-llama/llama-prompt-guard-2-22m"
    ],
}


class LocalLLMCooldown:
    """
    Simple cooldown tracker for Local LLM endpoints.
    Prevents excessive calls to local LLM by enforcing a cooldown period.
    """
    COOLDOWN_DURATION = 15.0  # 15 seconds cooldown
    
    def __init__(self):
        self._last_call_time: float = 0.0
        self._lock = threading.Lock()
    
    def is_in_cooldown(self) -> tuple[bool, float]:
        """Check if Local LLM is in cooldown. Returns (is_in_cooldown, remaining_seconds)."""
        with self._lock:
            now = time.time()
            elapsed = now - self._last_call_time
            if elapsed < self.COOLDOWN_DURATION:
                remaining = self.COOLDOWN_DURATION - elapsed
                return True, remaining
            return False, 0.0
    
    def update_call_time(self):
        """Update the last call time to now."""
        with self._lock:
            self._last_call_time = time.time()
    
    def get_status(self) -> dict:
        """Get cooldown status for monitoring."""
        is_cooldown, remaining = self.is_in_cooldown()
        return {
            "is_in_cooldown": is_cooldown,
            "remaining_seconds": round(remaining, 1),
            "cooldown_duration": self.COOLDOWN_DURATION
        }

# Initialize Local LLM cooldown tracker
local_llm_cooldown = LocalLLMCooldown()

async def _call_local_llm_fallback(
    messages: list[dict], 
    temperature: float | None = 0.7, 
    max_tokens: int | None = 4096
) -> dict | None:
    """
    Call local LLM endpoints when Groq returns 413 Payload Too Large.
    Randomly selects between available local LLM endpoints.
    
    Includes 15-second cooldown to prevent excessive calls.
    
    Supported endpoints:
    1. kanana-local (http://localhost:8889/chat/completions) - OpenAI-compatible
    2. ollama-kanana (http://192.168.30.169:11434) - Ollama API
    """
    # Check Local LLM cooldown first
    is_cooldown, remaining = local_llm_cooldown.is_in_cooldown()
    if is_cooldown:
        logger.info(f"⏳ Local LLM in cooldown ({remaining:.1f}s remaining). Skipping.")
        return None
    
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
            async with httpx.AsyncClient(timeout=120.0) as client:
                if endpoint_type == "openai-compatible":
                    # Direct OpenAI-compatible endpoint (like kanana API)
                    payload = {"messages": messages}
                    if temperature is not None:
                        payload["temperature"] = temperature
                    if max_tokens is not None:
                        payload["max_tokens"] = max_tokens
                    
                    response = await client.post(
                        endpoint_url,
                        json=payload,
                        headers={"Content-Type": "application/json"}
                    )
                    response.raise_for_status()
                    data = response.json()
                    
                    # Handle different response formats
                    if "choices" in data:
                        # Standard OpenAI format
                        content = data["choices"][0]["message"]["content"]
                    elif "content" in data:
                        # Simple format
                        content = data["content"]
                    elif "response" in data:
                        # Alternative format
                        content = data["response"]
                    else:
                        content = str(data)
                    
                    logger.info(f"Local LLM fallback ({endpoint_name}) succeeded")
                    # Update cooldown after successful call
                    local_llm_cooldown.update_call_time()
                    return {
                        "id": f"chatcmpl-local-{int(time.time())}",
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": f"local/{endpoint_name}",
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": content
                                },
                                "finish_reason": "stop"
                            }
                        ],
                        "usage": {
                            "prompt_tokens": sum(len(m.get("content", "") or "") // 4 for m in messages),
                            "completion_tokens": len(content) // 4,
                            "total_tokens": sum(len(m.get("content", "") or "") // 4 for m in messages) + len(content) // 4
                        }
                    }
                    
                elif endpoint_type == "ollama":
                    # Ollama API format
                    ollama_url = f"{endpoint_url}/api/chat"
                    
                    # Convert messages to Ollama format
                    ollama_messages = [
                        {"role": m["role"], "content": m["content"]}
                        for m in messages
                    ]
                    
                    payload = {
                        "model": endpoint_model,
                        "messages": ollama_messages,
                        "stream": False,
                        "options": {}
                    }
                    if temperature is not None:
                        payload["options"]["temperature"] = temperature
                    if max_tokens is not None:
                        payload["options"]["num_predict"] = max_tokens
                    
                    response = await client.post(
                        ollama_url,
                        json=payload,
                        headers={"Content-Type": "application/json"}
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
                        logger.error(f"Unexpected Ollama response format: {data.keys()}")
                    
                    logger.info(f"Local LLM fallback ({endpoint_name}) succeeded")
                    # Update cooldown after successful call
                    local_llm_cooldown.update_call_time()
                    return {
                        "id": f"chatcmpl-local-{int(time.time())}",
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": f"local/{endpoint_model or endpoint_name}",
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": content
                                },
                                "finish_reason": "stop"
                            }
                        ],
                        "usage": {
                            "prompt_tokens": data.get("prompt_eval_count", sum(len(m.get("content", "") or "") // 4 for m in messages)),
                            "completion_tokens": data.get("eval_count", len(content) // 4),
                            "total_tokens": data.get("prompt_eval_count", 0) + data.get("eval_count", 0)
                        }
                    }
                else:
                    logger.warning(f"Unknown endpoint type: {endpoint_type}")
                    continue
                    
        except httpx.HTTPStatusError as e:
            last_error = e
            logger.warning(f"Local LLM fallback ({endpoint_name}) HTTP error: {e.response.status_code} - {e.response.text[:200]}")
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
                {
                    "index": 0,
                    "delta": {"content": content},
                    "finish_reason": None
                }
            ]
        }
        yield f"data: {json.dumps(chunk_data)}\n\n"
        
        # Send finish chunk
        finish_data = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop"
                }
            ]
        }
        yield f"data: {json.dumps(finish_data)}\n\n"
        yield "data: [DONE]\n\n"
        
    except Exception as e:
        logger.error(f"Error streaming single response: {e}")
        error_data = {"error": str(e)}
        yield f"data: {json.dumps(error_data)}\n\n"


async def _stream_groq_response(response_iterator, model_name: str):
    """Generator for streaming Groq response in OpenAI format"""
    try:
        async for chunk in response_iterator:
            content = chunk.choices[0].delta.content
            if content:
                data = {
                    "id": f"chatcmpl-{int(time.time())}",
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model_name,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": content},
                            "finish_reason": None
                        }
                    ]
                }
                yield f"data: {json.dumps(data)}\n\n"
        
        # End of stream
        yield "data: [DONE]\n\n"
    except Exception as e:
        logger.error(f"Error during streaming: {e}")
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
        
    async def check_throttling(self) -> tuple[bool, float, str]:
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
                logger.info(f"Memo Processing Throttler: Starting NEW cycle (Running for {self.run_duration}s)")
                return True, 0.0, ""
                
            elif self.state == "RUNNING":
                elapsed = now - self.cycle_start_time
                if elapsed > self.run_duration:
                    # Time's up, enter cooldown
                    self.state = "COOLDOWN"
                    self.cooldown_start_time = now
                    remaining = self.cooldown_duration
                    logger.warning(f"Memo Processing Throttler: Run time exceeded ({elapsed:.1f}s). Entering COOLDOWN for {self.cooldown_duration}s")
                    return False, remaining, f"Memo processing limit reached. Cooling down for {int(remaining)}s."
                else:
                    return True, 0.0, ""
                    
            elif self.state == "COOLDOWN":
                elapsed = now - self.cooldown_start_time
                if elapsed > self.cooldown_duration:
                    # Cooldown finished, back to IDLE (or start running immediately)
                    self.state = "RUNNING"
                    self.cycle_start_time = now
                    logger.info(f"Memo Processing Throttler: Cooldown finished. Starting NEW cycle.")
                    return True, 0.0, ""
                else:
                    remaining = self.cooldown_duration - elapsed
                    return False, remaining, f"Memo processing in cooldown. Wait {int(remaining)}s."
            
            return True, 0.0, ""

memo_throttler = MemoProcessingThrottler(run_duration=120.0, cooldown_duration=180.0)


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    """
    OpenAI-compatible chat completion endpoint.
    Routes to Groq with Round-Robin key management AND Model Fallback.
    
    Enhanced Features:
    - Response Caching: Returns cached responses for identical requests
    - Key Health Scoring: Prioritizes healthier API keys
    - Token Budget Management: Tracks and limits TPM/TPD usage
    - Adaptive Throttling: Adjusts request delays based on error rate
    - Preemptive Cooldown: Warns when approaching daily limits
    """
    
    requested_model = request.model
    messages_payload = [{"role": m.role, "content": m.content} for m in request.messages]

    # 0. Check Response Cache FIRST (fastest path)
    cached_response = response_cache.get(messages_payload, requested_model)
    if cached_response and not request.stream:
        logger.info("📋 Returning cached response")
        return cached_response

    # 1. Check Global Rate Limit - Try Local LLM as last resort fallback
    is_globally_blocked, remaining_global = groq_rate_limiter.is_globally_blocked()
    if is_globally_blocked:
        logger.warning(f"🚨 Global Block active ({remaining_global:.1f}s remaining). Attempting Local LLM as last resort...")
        try:
            local_response = await _call_local_llm_fallback(messages_payload, request.temperature, request.max_tokens)
            if local_response:
                logger.info("✅ Local LLM succeeded during global block (last resort fallback)")
                if request.stream:
                    return StreamingResponse(
                        _stream_single_response(local_response), 
                        media_type="text/event-stream"
                    )
                return local_response
        except Exception as e:
            logger.error(f"❌ Local LLM fallback also failed during global block: {e}")
        
        # Local LLM failed, raise the original error
        raise HTTPException(
             status_code=429,
             detail=f"System is in global cooldown and local fallback failed. Retry in {int(remaining_global)} seconds.",
             headers={"Retry-After": str(int(remaining_global))}
        )
    
    # 2. Check if any (key, model) pairs are in cooldown cycle
    # If so, try Local LLM first before attempting Groq
    cooldown_pairs = groq_rate_limiter.get_any_key_model_in_cooldown()
    if cooldown_pairs:
        logger.info(f"🔄 {len(cooldown_pairs)} (key,model) pairs in cooldown cycle. Trying Local LLM FIRST.")
        try:
            local_response = await _call_local_llm_fallback(messages_payload, request.temperature, request.max_tokens)
            if local_response:
                logger.info("✅ Local LLM succeeded (cooldown fallback)")
                if request.stream:
                    return StreamingResponse(
                        _stream_single_response(local_response), 
                        media_type="text/event-stream"
                    )
                return local_response
        except Exception as e:
            logger.warning(f"Local LLM fallback failed during cooldown: {e}. Proceeding with Model→Key→Local fallback.")

    # Check for Memo Processing Throttle (Targeting Classification Model)
    # The default classification model is 'llama-3.1-8b-instant'
    if "llama-3.1-8b-instant" in requested_model:
        is_allowed, wait_time, msg = await memo_throttler.check_throttling()
        if not is_allowed:
            logger.warning(f"Memo throttler active ({msg}). Attempting LOCAL LLM fallback first.")
            # Try Local Fallback
            try:
                local_response = await _call_local_llm_fallback(messages_payload, request.temperature, request.max_tokens)
                if local_response:
                    logger.info("✅ Local LLM fallback succeeded during throttling")
                    if request.stream:
                        return StreamingResponse(
                            _stream_single_response(local_response), 
                            media_type="text/event-stream"
                        )
                    return local_response
            except Exception as e:
                logger.error(f"Local fallback failed during throttling: {e}")
            
            logger.warning("Local fallback failed or unavailable during throttle. Proceeding to standard Groq fallback chain.")
    
    # Determined fallback chain based on requested model
    # If requested model is not in our known list, try to map it or default to Qwen
    if requested_model in GROQ_MODEL_FALLBACKS:
        model_chain = GROQ_MODEL_FALLBACKS[requested_model]
    else:
        # Check if it's one of the known models but not a primary key
        found = False
        for chain in GROQ_MODEL_FALLBACKS.values():
            if requested_model in chain:
                model_chain = chain # Use the chain that contains this model
                # Move requested model to front of chain
                model_chain = [m for m in model_chain if m != requested_model]
                model_chain.insert(0, requested_model)
                found = True
                break
        
        if not found:
            logger.info(f"Requested model {requested_model} unknown, defaulting to llama-3.3-70b-versatile chain")
            model_chain = GROQ_MODEL_FALLBACKS["llama-3.3-70b-versatile"]

    if not groq_key_manager:
        raise HTTPException(status_code=503, detail="Groq API keys not configured")
    
    # Log input size for debugging "Request Entity Too Large" errors
    total_chars = sum(len(m.get("content", "") or "") for m in messages_payload)
    estimated_tokens = total_chars // 4  # Rough estimate: 1 token ≈ 4 chars
    logger.info(f"Chat request: model={requested_model}, messages={len(messages_payload)}, chars={total_chars}, est_tokens≈{estimated_tokens}")
    
    # Get all available keys and sort by health score (healthiest first)
    all_keys = groq_key_manager.get_all_keys()
    all_keys = key_health_tracker.get_healthiest_keys(all_keys)
    
    # Track errors to report if all fail
    last_exception = None
    
    # Record request in adaptive throttler
    adaptive_throttler.record_request()
    

    # Try everything twice (with a 90s wait in between)
    for attempt in range(2):
        if attempt > 0:
            logger.warning("All keys and models exhausted on first attempt. Waiting 90 seconds before final retry...")
            await asyncio.sleep(90)
            logger.info("Resuming retry after 90s wait...")

        # Strategy: Iterate through models in the fallback chain (Model-First)
        # For each model, try ALL available keys.
        for model_index, target_model in enumerate(model_chain):
            logger.info(f"Fallback Chain [{model_index+1}/{len(model_chain)}]: Trying Model '{target_model}' (Attempt {attempt+1})")
            
            # Key Rotation Optimization:
            # Shift the keys list so we don't always start with the same key (Load Balancing)
            # We use a simple counter from GroqKeyManager if possible, or just random
            # For strictness, let's just use the order but maybe randomized start? 
            # Actually, let's just use simple iteration but log explicitly.
            
            # Try all keys for this model
            for key_index, current_key in enumerate(all_keys):
                try:
                    # PROTECTION: Skip permanently blocked keys
                    if current_key in groq_key_manager._permanently_blocked:
                        logger.warning(f"  > Skipping Permanently Blocked: KeyIndex={key_index + 1}")
                        continue
                    
                    # Check (key, model) cooldown cycle - if in cooldown, try local first
                    is_cooldown, cooldown_remaining = groq_rate_limiter.is_in_cooldown(current_key, target_model)
                    if is_cooldown:
                        logger.info(f"  > (Key={key_index + 1}, Model={target_model}) in COOLDOWN cycle ({cooldown_remaining:.1f}s remaining). Trying Local LLM...")
                        try:
                            local_response = await _call_local_llm_fallback(messages_payload, request.temperature, request.max_tokens)
                            if local_response:
                                logger.info(f"✅ Local LLM fallback succeeded during cooldown cycle")
                                if request.stream:
                                    return StreamingResponse(
                                        _stream_single_response(local_response), 
                                        media_type="text/event-stream"
                                    )
                                return local_response
                        except Exception as e:
                            logger.warning(f"Local LLM fallback failed: {e}. Continuing to next (key, model)...")
                        continue  # Skip this (key, model) and try next
                    
                    # Check if currently blocked (Circuit Breaker due to errors)
                    if groq_rate_limiter.is_blocked(current_key, target_model):
                        logger.warning(f"  > Skipping Blocked: Model={target_model} | KeyIndex={key_index + 1} (Recent 429)")
                        continue
                    
                    # Token Budget Check: Skip if this (key, model) would exceed limits
                    is_ok, budget_msg = token_budget_manager.check_limits(current_key, target_model, estimated_tokens)
                    if not is_ok:
                        logger.warning(f"  > Skipping due to budget: {budget_msg} | Key={key_index + 1} Model={target_model}")
                        continue
                    
                    # Preemptive Cooldown Check: Warn if approaching limits
                    is_approaching, approach_msg = token_budget_manager.is_approaching_limit(current_key, target_model)
                    if is_approaching:
                        logger.warning(f"⚠️ Approaching limit: {approach_msg} | Key={key_index + 1} Model={target_model}")

                    # Adaptive Throttling: Get recommended delay based on recent error rate
                    recommended_delay = adaptive_throttler.get_recommended_delay()
                    
                    # Gentle Throttling: Check local rate limit (RPM)
                    rpm_wait = groq_rate_limiter.get_wait_time(current_key, target_model)
                    
                    # Apply the larger of RPM-based wait or adaptive delay
                    actual_wait = max(rpm_wait, recommended_delay)
                    if actual_wait > 0 and actual_wait < 300:  # Wait only if reasonable
                        logger.debug(f"THROTTLE: Waiting {actual_wait:.2f}s (adaptive={recommended_delay:.2f}, rpm_wait={rpm_wait:.2f}) for Model {target_model}")
                        await asyncio.sleep(actual_wait)
                    
                    # Update usage time immediately (optimistic)
                    await groq_rate_limiter.update_request_time(current_key, target_model)


                    logger.info(f"  > Attempting Chat: Model={target_model} | KeyIndex={key_index + 1}/{len(all_keys)} | KeyPrefix={current_key[:8]}...")
                    client = AsyncGroq(api_key=current_key, max_retries=0)
                    
                    completion = await client.chat.completions.create(
                        model=target_model,
                        messages=messages_payload,
                        temperature=request.temperature or 0.6,
                        max_completion_tokens=request.max_tokens or 4096,
                        top_p=0.95,
                        stream=request.stream,
                    )
                    
                    # Record success in health tracker
                    key_health_tracker.record_success(current_key)
                    
                    # Record token usage in budget manager
                    if hasattr(completion, 'usage') and completion.usage:
                        token_budget_manager.record_usage(
                            current_key, 
                            target_model, 
                            completion.usage.total_tokens
                        )
                    
                    if request.stream:
                        return StreamingResponse(
                            _stream_groq_response(completion, target_model), 
                            media_type="text/event-stream"
                        )
                    else:
                        response_data = {
                            "id": f"chatcmpl-{int(time.time())}",
                            "object": "chat.completion",
                            "created": int(time.time()),
                            "model": target_model,
                            "choices": [
                                {
                                    "index": 0,
                                    "message": {
                                        "role": "assistant",
                                        "content": completion.choices[0].message.content
                                    },
                                    "finish_reason": completion.choices[0].finish_reason
                                }
                            ],
                            "usage": {
                                "prompt_tokens": completion.usage.prompt_tokens,
                                "completion_tokens": completion.usage.completion_tokens,
                                "total_tokens": completion.usage.total_tokens
                            }
                        }
                        
                        # Cache the response for future identical requests
                        response_cache.set(messages_payload, target_model, response_data)
                        
                        return response_data
                        
                except Exception as e:
                    error_str = str(e)
                    last_exception = e
                    
                    # Record error in health tracker and adaptive throttler
                    key_health_tracker.record_error(current_key, error_str[:50])
                    adaptive_throttler.record_error()
                    
                    # PROTECTION: Check for organization restriction (PERMANENT BLOCK)
                    is_org_restricted = (
                        "organization" in error_str.lower() and "restricted" in error_str.lower()
                    ) or (
                        "org" in error_str.lower() and "block" in error_str.lower()
                    ) or (
                        "account" in error_str.lower() and "suspended" in error_str.lower()
                    )
                    
                    # Check for 413 Payload Too Large FIRST - fallback to local LLM immediately
                    is_payload_too_large = (
                        "413" in error_str or 
                        "payload too large" in error_str.lower() or
                        "request entity too large" in error_str.lower() or
                        "content too large" in error_str.lower()
                    )
                    
                    if is_payload_too_large:
                        logger.warning(f"� Payload Too Large (413) on Groq. Immediately falling back to local LLM...")
                        
                        # Try local LLM fallback immediately - no more Groq attempts
                        try:
                            local_response = await _call_local_llm_fallback(messages_payload, request.temperature, request.max_tokens)
                            if local_response:
                                logger.info(f"✅ Local LLM fallback succeeded for 413 error")
                                
                                # If client requested stream, we need to convert the single response to a stream
                                if request.stream:
                                    return StreamingResponse(
                                        _stream_single_response(local_response), 
                                        media_type="text/event-stream"
                                    )
                                else:
                                    return local_response
                        except Exception as local_err:
                            logger.error(f"❌ Local LLM fallback also failed: {local_err}")
                            raise HTTPException(
                                status_code=413, 
                                detail=f"Payload too large for Groq and local LLM fallback failed: {str(local_err)}"
                            )
                    
                    if is_org_restricted:
                        # CRITICAL: This key is now permanently unusable
                        groq_key_manager.mark_permanently_blocked(current_key, f"Organization Restricted: {error_str[:100]}")
                        logger.critical(f"🚨 KEY [{key_index + 1}] GOT ORGANIZATION RESTRICTED! Permanently blocked.")
                        
                        # Long delay before trying another key to avoid triggering more restrictions
                        logger.warning("Waiting 60s before trying another key to avoid more restrictions...")
                        await asyncio.sleep(60)
                        continue
                    
                    is_rate_limit = (
                        "429" in error_str or 
                        "rate" in error_str.lower() or 
                        "limit" in error_str.lower()
                    )
                    
                    if is_rate_limit:
                        # Rate limit hit -> Block this (Key, Model) for 15 minutes (900s)
                        await groq_rate_limiter.block_key_model(current_key, target_model, duration=groq_rate_limiter.ERROR_COOLDOWN_DURATION)
                        logger.warning(f"Rate Limit (429) on Model [{target_model}] with Key [{key_index + 1}]. Blocking for {groq_rate_limiter.ERROR_COOLDOWN_DURATION}s (15 min).")
                        
                        # Try Local LLM as fallback for this error
                        logger.info("Attempting Local LLM fallback after 429 error...")
                        try:
                            local_response = await _call_local_llm_fallback(messages_payload, request.temperature, request.max_tokens)
                            if local_response:
                                logger.info(f"✅ Local LLM fallback succeeded after 429 error")
                                if request.stream:
                                    return StreamingResponse(
                                        _stream_single_response(local_response), 
                                        media_type="text/event-stream"
                                    )
                                return local_response
                        except Exception as local_err:
                            logger.warning(f"Local LLM fallback also failed: {local_err}")
                        
                        # PROTECTION: Short delay before switching to avoid aggressive behavior
                        logger.info("PROTECTION: Waiting 5s before trying NEXT KEY to avoid aggressive behavior...")
                        await asyncio.sleep(5)
                        continue 
                    else:
                        # Non-rate-limit error.
                        if "not found" in error_str.lower() or "load" in error_str.lower():
                             # Model specific error? Skip to next MODEL.
                             logger.warning(f"Model error ({error_str}) on {target_model}. Skipping to next model.")
                             break # Break inner loop, go to next outer loop (Model)
                        
                        # Connection errors etc might be retryable on next key
                        if "connect" in error_str.lower() or "timeout" in error_str.lower():
                            logger.warning(f"Connection error on Key [{key_index + 1}] for {target_model}: {error_str}. Trying next key...")
                            
                            # Add 10s delay even for connection errors just in case
                            logger.info("Waiting 10s before switching key...")
                            await asyncio.sleep(10)
                            continue

                        # Other errors (auth, bad request) -> fail immediately
                        logger.error(f"Groq chat fatal error: {error_str}")
                        raise HTTPException(status_code=500, detail=f"Groq Error: {error_str}")

            # If we exit the key loop naturally, it means all keys failed (likely 429s) for this model.
            # We proceed to the next model in 'model_chain'.
            logger.warning(f"All keys exhausted for model {target_model}. Falling back to next model in chain...")

    # If we fall through ALL models and ALL keys TWICE
    # Activate global cooldown for 300 seconds
    await groq_rate_limiter.activate_global_block(300.0)

    raise HTTPException(
        status_code=429, 
        detail=f"All models and API keys exhausted after retry. System entering global cooldown (300s). Last error: {str(last_exception)}"
    )


@app.get("/groq/status")
async def get_groq_status():
    """
    Get comprehensive status of Groq API management including:
    - Rate limiter status (blocked keys, cooldown cycles)
    - Key health scores
    - Token budget usage
    - Adaptive throttler status
    - Response cache statistics
    - Local LLM cooldown status
    """
    return {
        "rate_limiter": groq_rate_limiter.get_status(),
        "key_health": key_health_tracker.get_status(),
        "token_budget": token_budget_manager.get_status(),
        "adaptive_throttler": adaptive_throttler.get_status(),
        "response_cache": response_cache.get_status(),
        "local_llm_cooldown": local_llm_cooldown.get_status(),
        "groq_model_limits": {
            model: {
                "rpm": limits["rpm"],
                "rpd": limits["rpd"],
                "tpm": limits["tpm"],
                "tpd": limits["tpd"] or "unlimited"
            }
            for model, limits in GROQ_MODEL_LIMITS.items()
        }
    }


@app.get("/groq/health")
async def get_groq_health():
    """Get quick health summary of Groq API usage."""
    throttler_status = adaptive_throttler.get_status()
    cache_status = response_cache.get_status()
    
    # Determine overall health
    error_rate = throttler_status["error_rate"]
    if error_rate < 0.1:
        health_status = "healthy"
    elif error_rate < 0.3:
        health_status = "degraded"
    else:
        health_status = "unhealthy"
    
    return {
        "status": health_status,
        "error_rate": error_rate,
        "delay_multiplier": throttler_status["delay_multiplier"],
        "cache_hit_rate": cache_status["hit_rate"],
        "is_globally_blocked": groq_rate_limiter.is_globally_blocked()[0],
        "available_keys": groq_key_manager.get_available_key_count() if groq_key_manager else 0,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
