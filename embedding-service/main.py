
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
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "models/text-embedding-004")
RERANK_MODEL = os.getenv("RERANK_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
TARGET_DIMENSION = int(os.getenv("TARGET_DIMENSION", "768"))
EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "local")  # local, ollama, or gemini
RERANK_PROVIDER = os.getenv("RERANK_PROVIDER", EMBEDDING_PROVIDER)  # ollama, local, or same as embedding
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

# Round-robin key iterator
import itertools
gemini_key_cycle = None

if EMBEDDING_PROVIDER == "ollama" or RERANK_PROVIDER == "ollama":
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

if RERANK_PROVIDER == "local":
    try:
        from sentence_transformers import CrossEncoder
        rerank_model = CrossEncoder(RERANK_MODEL)
        logger.info(f"Loaded local rerank model: {RERANK_MODEL}")
    except Exception as e:
        logger.error(f"Failed to load local rerank model: {e}")
        logger.info("Falling back to Ollama provider for rerank")
        RERANK_PROVIDER = "ollama"

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


def _gemini_call(text: str, api_key: str, model: str) -> list[float]:
    genai.configure(api_key=api_key)
    result = genai.embed_content(
        model=model,
        content=text,
        task_type="retrieval_document"
    )
    return result['embedding']


async def get_gemini_embedding(text: str) -> list[float]:
    """Get embedding from Gemini API using round-robin keys"""
    try:
        # Rotate API key
        if gemini_key_cycle:
            current_key = next(gemini_key_cycle)
        else:
             raise ValueError("No Gemini API keys configured")

        return await run_in_threadpool(_gemini_call, text, current_key, EMBEDDING_MODEL)
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


async def rerank_with_ollama(query: str, documents: list[str]) -> list[tuple[int, float]]:
    """
    Rerank documents using Ollama embedding model.
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



class EmbedRequest(BaseModel):
    content: str = Field(..., description="Text content to embed")
    normalize: bool = Field(
        default=True, description="Whether to normalize to target dimension"
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


# Endpoints
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "provider": EMBEDDING_PROVIDER}


@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest):
    """
    Generate embeddings for the provided text content.

    Args:
        request: EmbedRequest containing the text content and normalization preference

    Returns:
        EmbedResponse with the embedding vector and its dimension
    """
    try:
        if EMBEDDING_PROVIDER == "ollama":
            embedding = await get_ollama_embedding(request.content)
        elif EMBEDDING_PROVIDER == "gemini":
            embedding = await get_gemini_embedding(request.content)
        elif EMBEDDING_PROVIDER == "local":
            if embedding_model is None:
                raise HTTPException(status_code=503, detail="Local embedding model not available")
            embedding = embedding_model.encode(request.content).tolist()
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
    Rerank documents based on their relevance to the query using a cross-encoder model.

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

        # For now, if rerank_model is not available, use simple scoring
        if RERANK_PROVIDER == "ollama":
            # Use Ollama embedding-based reranking
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
        
        elif rerank_model is None:
            logger.warning("Rerank model not available, using fallback scoring")
            # Simple fallback: return documents in original order with decreasing scores
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

        def get_document_text(doc):
            if isinstance(doc, str):
                return doc
            if isinstance(doc, dict):
                for field in ["text", "content", "document", "page_content"]:
                    if field in doc:
                        return doc[field]
            return str(doc)

        pairs_start = time.perf_counter()
        pairs = [[request.query, get_document_text(doc)] for doc in request.documents]
        logger.debug(f"Created {len(pairs)} query-document pairs (took {time.perf_counter() - pairs_start:.6f}s)")

        predict_start = time.perf_counter()
        scores = rerank_model.predict(pairs)
        logger.debug(f"Model prediction completed for {len(scores)} documents (took {time.perf_counter() - predict_start:.6f}s)")

        normalize_start = time.perf_counter()
        normalized_scores = 1 / (1 + np.exp(-np.array(scores)))
        logger.debug(f"Score normalization completed (took {time.perf_counter() - normalize_start:.6f}s)")

        build_start = time.perf_counter()
        reranked = []
        for idx, (doc, score) in enumerate(zip(request.documents, normalized_scores)):
            reranked.append(
                RerankResult(
                    index=idx,
                    document=get_document_text(doc),
                    relevance_score=float(f"{score:.6f}"),
                )
            )
        logger.debug(f"Built {len(reranked)} reranked results (took {time.perf_counter() - build_start:.6f}s)")

        sort_start = time.perf_counter()
        reranked.sort(key=lambda r: r.relevance_score, reverse=True)
        logger.debug(f"Sorted reranked results (took {time.perf_counter() - sort_start:.6f}s)")

        filter_start = time.perf_counter()
        if isinstance(request.top_k, int) and request.top_k > 0:
            reranked = reranked[: request.top_k]
            logger.debug(f"Filtered to top_k={request.top_k} results (took {time.perf_counter() - filter_start:.6f}s)")
        else:
            logger.debug(f"No top_k filtering applied (took {time.perf_counter() - filter_start:.6f}s)")

        total_time = time.perf_counter() - start_time
        logger.debug(f"Rerank completed successfully: returning {len(reranked)} results (total time: {total_time:.6f}s)")
        return RerankResponse(results=reranked)
    except Exception as e:
        total_time = time.perf_counter() - start_time
        logger.error(f"Rerank failed after {total_time:.6f}s: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Reranking failed: {str(e)}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
