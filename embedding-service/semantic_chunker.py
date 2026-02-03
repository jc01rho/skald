# semantic_chunker.py
# Python module for embedding-service

from typing import List
import numpy as np
from sentence_transformers import SentenceTransformer


class SemanticChunker:
    def __init__(self, model_name: str = "all-MiniLM-L6-v2"):
        self.model = SentenceTransformer(model_name)
        self.similarity_threshold = 0.7

    def split_into_sentences(self, text: str) -> List[str]:
        """Split text into sentences using simple heuristics"""
        import re
        
        # Handle both English and Korean sentence endings
        sentences = re.split(r'(?<=[.!?。！？])\s+', text)
        return [s.strip() for s in sentences if s.strip()]

    def calculate_similarity(self, sent1: str, sent2: str) -> float:
        """Calculate cosine similarity between two sentences"""
        emb1 = self.model.encode(sent1)
        emb2 = self.model.encode(sent2)
        
        return float(np.dot(emb1, emb2) / (np.linalg.norm(emb1) * np.linalg.norm(emb2)))

    def detect_topic_shifts(self, sentences: List[str]) -> List[int]:
        """Detect indices where topic shifts occur"""
        if len(sentences) < 2:
            return []
        
        shifts = []
        for i in range(1, len(sentences)):
            similarity = self.calculate_similarity(sentences[i-1], sentences[i])
            if similarity < self.similarity_threshold:
                shifts.append(i)
        
        return shifts

    def semantic_chunk(self, text: str, max_chunk_size: int = 512) -> List[str]:
        """
        Create semantic chunks based on topic coherence
        
        Args:
            text: Input text to chunk
            max_chunk_size: Maximum characters per chunk
            
        Returns:
            List of semantic chunks
        """
        sentences = self.split_into_sentences(text)
        
        if not sentences:
            return []
        
        topic_shifts = self.detect_topic_shifts(sentences)
        
        chunks = []
        current_chunk = []
        current_size = 0
        
        for i, sentence in enumerate(sentences):
            sentence_size = len(sentence)
            
            # Start new chunk if:
            # 1. Topic shift detected
            # 2. Chunk size would exceed limit
            if (i in topic_shifts or 
                (current_size + sentence_size > max_chunk_size and current_chunk)):
                if current_chunk:
                    chunks.append(" ".join(current_chunk))
                current_chunk = [sentence]
                current_size = sentence_size
            else:
                current_chunk.append(sentence)
                current_size += sentence_size
        
        # Add remaining sentences
        if current_chunk:
            chunks.append(" ".join(current_chunk))
        
        return chunks


# FastAPI endpoint for integration
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
chunker = SemanticChunker()


class ChunkRequest(BaseModel):
    text: str
    max_chunk_size: int = 512


class ChunkResponse(BaseModel):
    chunks: List[str]
    count: int


@app.post("/semantic-chunk", response_model=ChunkResponse)
async def semantic_chunk_endpoint(request: ChunkRequest):
    chunks = chunker.semantic_chunk(request.text, request.max_chunk_size)
    return ChunkResponse(chunks=chunks, count=len(chunks))
