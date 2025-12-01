import logging
import os
import time
from typing import Literal, Optional
import httpx

import numpy as np
from fastapi import FastAPI, HTTPException
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
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
RERANK_MODEL = os.getenv("RERANK_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
TARGET_DIMENSION = int(os.getenv("TARGET_DIMENSION", "2048"))
EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "local")  # local, ollama, or gemini
OLLAMA_BASE_URL = os.getenv("LOCAL_LLM_BASE_URL", "http://localhost:11434")

print(f"Using embedding provider: {EMBEDDING_PROVIDER}")
print(f"Using embedding model: {EMBEDDING_MODEL}")
print(f"Using rerank model: {RERANK_MODEL}")
print(f"Using target dimension: {TARGET_DIMENSION}")
if EMBEDDING_PROVIDER == "ollama":
    print(f"Using Ollama base URL: {OLLAMA_BASE_URL}")

# Initialize models lazily based on provider
embedding_model = None
rerank_model = None

if EMBEDDING_PROVIDER == "local":
    try:
        from sentence_transformers import SentenceTransformer, CrossEncoder
        embedding_model = SentenceTransformer(EMBEDDING_MODEL)
        rerank_model = CrossEncoder(RERANK_MODEL)
        logger.info(f"Loaded local embedding model: {EMBEDDING_MODEL}")
    except Exception as e:
        logger.error(f"Failed to load local models: {e}")
        logger.info("Falling back to Ollama provider")
        EMBEDDING_PROVIDER = "ollama"

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


# Request/Response Models
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
        if rerank_model is None:
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
