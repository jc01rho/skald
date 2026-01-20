# Search Result Improvements for RAG Platform

## Overview

Implemented enhanced search ranking for Jira issues and technical guides with metadata-aware scoring, temporal relevance weighting, and improved result quality.

## Changes Made

### 1. New File: `backend/src/lib/searchRanking.ts`

Created comprehensive ranking system with:

#### Metadata-Aware Scoring

- **Jira Issue Boosts**:
    - Open/In Progress: +0.10 boost
    - Critical priority: +0.15 boost
    - Bug issues: +0.03 boost
    - Resolved/Closed: -0.05 penalty

- **Technical Guide Boosts**:
    - Advanced difficulty: +0.10 boost
    - Intermediate: +0.08 boost
    - Beginner: +0.05 boost
    - Popular guides (10+ views): +0.05 boost

#### Temporal Relevance Weighting

- Exponential decay based on age:
    - Creation: 90-day half-life
    - Updates: 60-day half-life (freshness)
- Maximum boost: 0.15 for very recent content
- Factors updates more heavily than creation

#### Scoring Formula

```
final_score = 0.60 * vector_similarity +
             0.20 * recency_boost +
             0.15 * metadata_boost +
             0.05 * content_type_boost
```

### 2. Updated: `backend/src/embeddings/vectorSearch.ts`

#### New Interface

```typescript
export interface MemoChunkWithDistanceAndScore {
    chunk: { ... }
    distance: number
    final_score: number
    ranking_factors?: {
        vector_similarity: number
        recency_boost: number
        metadata_boost: number
        content_type_boost: number
    }
}
```

#### Enhanced SQL Query

Now fetches memo metadata:

```sql
SELECT
    skald_memochunk.*,
    (skald_memochunk.embedding <=> ?::vector) as distance,
    skald_memo.created_at,
    skald_memo.updated_at,
    skald_memo.title,
    skald_memo.metadata
FROM skald_memochunk
JOIN skald_memo ON skald_memochunk.memo_id = skald_memo.uuid
...
```

#### Enhanced Ranking Logic

1. Fetches 2x results (topK \* 2) for reranking
2. Applies enhanced ranking with metadata and temporal factors
3. Sorts by `final_score` descending
4. Returns topK results

### 3. Updated: `backend/src/agents/chatAgent/ragGraph.ts`

#### Vector Search Call

```typescript
return memoChunkVectorSearch(
    project,
    embeddingVector,
    ragConfig.vectorSearch.topK,
    ragConfig.vectorSearch.similarityThreshold,
    filters,
    true // Use enhanced ranking
)
```

#### Fallback to Enhanced Scores

When reranking is disabled, uses `final_score` from enhanced ranking instead of simple similarity.

## Metadata Schema

### Jira Issues

```typescript
{
    content_type: 'jira_issue',
    jira_key: 'PROJ-123',
    jira_status: 'Open',
    jira_priority: 'Critical',
    jira_assignee: 'john.doe',
    jira_created: '2025-01-01',
    jira_updated: '2025-01-15',
    jira_resolution: null,
    jira_issue_type: 'Bug'
}
```

### Technical Guides

```typescript
{
    content_type: 'technical_guide',
    guide_category: 'Database',
    guide_tags: ['postgresql', 'indexing'],
    guide_last_updated: '2025-01-10',
    guide_author: 'jane.smith',
    guide_difficulty: 'Advanced'
}
```

## Ranking Factors Breakdown

| Factor            | Weight | Impact                   |
| ----------------- | ------ | ------------------------ |
| Vector Similarity | 60%    | Primary relevance signal |
| Recency           | 20%    | Freshness of content     |
| Metadata          | 15%    | Priority, status, type   |
| Content Type      | 5%     | Contextual relevance     |

## Benefits

1. **Better Relevance**: Jira issues with high priority and open status rank higher
2. **Freshness**: Recently updated content gets visibility boost
3. **Content-Type Awareness**: Different scoring for issues vs guides
4. **Metadata Utilization**: Leverages existing metadata fields
5. **Backward Compatible**: Falls back to simple scoring if metadata missing

## Usage

### Enable Enhanced Ranking

Enhanced ranking is enabled by default. To disable:

```typescript
// In vectorSearch call
const results = await memoChunkVectorSearch(
    project,
    embeddingVector,
    topK,
    similarityThreshold,
    filters,
    false // Disable enhanced ranking
)
```

### Add Metadata to Memos

```typescript
// When creating a Jira issue memo
const memo = new Memo()
memo.title = 'Fix login bug'
memo.metadata = {
    content_type: 'jira_issue',
    jira_key: 'PROJ-123',
    jira_status: 'Open',
    jira_priority: 'Critical',
    jira_issue_type: 'Bug',
}

// When creating a technical guide
const guide = new Memo()
guide.title = 'PostgreSQL Indexing Guide'
guide.metadata = {
    content_type: 'technical_guide',
    guide_category: 'Database',
    guide_tags: ['postgresql', 'indexing'],
    guide_difficulty: 'Advanced',
}
```

## Future Enhancements

1. **Hybrid Search**: Combine vector search with keyword/BM25
2. **Relevance Feedback Loop**: Learn from user interactions
3. **Custom Scoring Rules**: Per-project or per-content-type rules
4. **Query-Type Awareness**: Different ranking for different query types
5. **Advanced MMR**: Proper embedding-based MMR for diversity

## Testing

To test the enhanced ranking:

```bash
# Create test memos with metadata
curl -X POST "http://localhost:3000/api/memo" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Critical Jira Issue",
    "content": "Login fails for all users",
    "metadata": {
      "content_type": "jira_issue",
      "jira_key": "PROJ-123",
      "jira_status": "Open",
      "jira_priority": "Critical"
    }
  }'

# Search and check ranking
curl -X POST "http://localhost:3000/api/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "login bug",
    "project_uuid": "..."
  }'
```

Expected behavior:

- Critical Jira issues rank higher than low-priority ones
- Recently updated content gets boost
- Open issues rank higher than resolved ones
- Technical guides with appropriate difficulty get boost
