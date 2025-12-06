
import asyncio
import logging
import os
import time
from typing import Literal, Optional
import httpx
import google.generativeai as genai

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

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
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "models/gemini-embedding-001")
RERANK_MODEL = os.getenv("RERANK_MODEL", "dragonkue/bge-reranker-v2-m3-ko")
TARGET_DIMENSION = int(os.getenv("TARGET_DIMENSION", "768"))
EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "gemini")  # local, ollama, or gemini
RERANK_PROVIDER = os.getenv("RERANK_PROVIDER", "local")  # local (CrossEncoder), ollama
QUERY_LANGUAGE = os.getenv("QUERY_LANGUAGE", "ko")  # 한글 최적화 기본값
_ollama_url = os.getenv("LOCAL_LLM_BASE_URL", "http://localhost:11434")
# Remove /v1 suffix if present (Ollama native API doesn't use /v1)
OLLAMA_BASE_URL = _ollama_url.rstrip("/").removesuffix("/v1")
GEMINI_API_KEYS_STR = os.getenv("GEMINI_API_KEY", "")
GEMINI_API_KEYS = [k.strip() for k in GEMINI_API_KEYS_STR.split(",") if k.strip()]

print(f"Using embedding provider: {EMBEDDING_PROVIDER}")
print(f"Using rerank provider: {RERANK_PROVIDER}")
print(f"Using embedding model: {EMBEDDING_MODEL}")
print(f"Using rerank model: {RERANK_MODEL}")
print(f"Using target dimension: {TARGET_DIMENSION}")
print(f"Query language: {QUERY_LANGUAGE}")

# Round-robin key iterator
import itertools
gemini_key_cycle = None

if EMBEDDING_PROVIDER == "ollama":
    print(f"Using Ollama base URL: {OLLAMA_BASE_URL}")
if EMBEDDING_PROVIDER == "gemini":
    if not GEMINI_API_KEYS:
        logger.error("GEMINI_API_KEY is not set")
    else:
        gemini_key_cycle = itertools.cycle(GEMINI_API_KEYS)
        print(f"Gemini API configured with {len(GEMINI_API_KEYS)} keys")

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
        # Vector too large - not supported
        raise ValueError(
            f"Embedding dimension {current_dim} exceeds maximum supported dimension {TARGET_DIMENSION}"
        )


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


def _gemini_call(text: str, api_key: str, model: str, task_type: str = "retrieval_document") -> list[float]:
    """
    Gemini 임베딩 API 호출
    한글 텍스트에 최적화된 task_type 사용
    """
    genai.configure(api_key=api_key)
    result = genai.embed_content(
        model=model,
        content=text,
        task_type=task_type
    )
    return result['embedding']


async def get_gemini_embedding(text: str, usage: str = "storage") -> list[float]:
    """
    Get embedding from Gemini API using round-robin keys
    한글 텍스트에 최적화된 task_type 자동 선택
    """
    try:
        # Rotate API key
        if gemini_key_cycle:
            current_key = next(gemini_key_cycle)
        else:
             raise ValueError("No Gemini API keys configured")

        # 한글 최적화: 적절한 task_type 선택
        task_type = get_task_type_for_korean(usage)
        
        # 한글 쿼리 전처리
        processed_text = preprocess_korean_query(text) if usage == "search" else text
        
        return await run_in_threadpool(_gemini_call, processed_text, current_key, EMBEDDING_MODEL, task_type)
    except Exception as e:
        logger.error(f"Failed to get embedding from Gemini: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Gemini API error: {str(e)}")


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
        elif EMBEDDING_PROVIDER == "gemini":
            embedding = await get_gemini_embedding(request.content, usage)
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
