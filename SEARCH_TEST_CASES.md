# Test Cases for Enhanced Search Ranking

## Test 1: Jira Issue Priority Ranking

### Setup

Create three Jira issue memos with different priorities:

```typescript
// Critical priority issue
const criticalIssue = new Memo()
criticalIssue.title = 'Critical: Database connection fails'
criticalIssue.content = 'Database connection fails for all users'
criticalIssue.metadata = {
    content_type: 'jira_issue',
    jira_key: 'PROJ-001',
    jira_status: 'Open',
    jira_priority: 'Critical',
    jira_issue_type: 'Bug',
}
criticalIssue.created_at = new Date('2025-01-15')
criticalIssue.updated_at = new Date('2025-01-15')

// Low priority issue
const lowPriorityIssue = new Memo()
lowPriorityIssue.title = 'Low: Update documentation'
lowPriorityIssue.content = 'Update API documentation'
lowPriorityIssue.metadata = {
    content_type: 'jira_issue',
    jira_key: 'PROJ-002',
    jira_status: 'Open',
    jira_priority: 'Low',
    jira_issue_type: 'Task',
}
lowPriorityIssue.created_at = new Date('2025-01-01')
lowPriorityIssue.updated_at = new Date('2025-01-01')

// Resolved issue
const resolvedIssue = new Memo()
resolvedIssue.title = 'Resolved: Login issue'
resolvedIssue.content = 'Login issue for admin users'
resolvedIssue.metadata = {
    content_type: 'jira_issue',
    jira_key: 'PROJ-003',
    jira_status: 'Resolved',
    jira_priority: 'High',
    jira_issue_type: 'Bug',
}
resolvedIssue.created_at = new Date('2025-01-10')
resolvedIssue.updated_at = new Date('2025-01-12')
```

### Query

```
"database connection failure"
```

### Expected Ranking Order

1. Critical issue (high priority + recent + bug type)
2. Resolved issue (high priority but resolved penalty)
3. Low priority issue (low priority + old)

### Test 2: Temporal Relevance

### Setup

Create same priority issues with different update dates:

```typescript
// Recently updated (yesterday)
const recentIssue = new Memo()
recentIssue.title = 'API timeout issue'
recentIssue.content = 'API calls timeout after 30s'
recentIssue.metadata = {
    content_type: 'jira_issue',
    jira_priority: 'High',
    jira_status: 'Open',
}
recentIssue.created_at = new Date('2025-01-01')
recentIssue.updated_at = new Date('2025-01-14')

// Stale issue (3 months old)
const staleIssue = new Memo()
staleIssue.title = 'Another API timeout issue'
staleIssue.content = 'API calls timeout after 30s'
staleIssue.metadata = {
    content_type: 'jira_issue',
    jira_priority: 'High',
    jira_status: 'Open',
}
staleIssue.created_at = new Date('2024-10-01')
staleIssue.updated_at = new Date('2024-10-15')
```

### Query

```
"API timeout"
```

### Expected Ranking Order

1. Recently updated issue (freshness boost)
2. Stale issue (no freshness boost)

### Test 3: Technical Guide Difficulty

### Setup

Create guides with different difficulty:

```typescript
// Advanced guide
const advancedGuide = new Memo()
advancedGuide.title = 'Advanced PostgreSQL Indexing'
advancedGuide.content = 'Advanced indexing strategies...'
advancedGuide.metadata = {
    content_type: 'technical_guide',
    guide_category: 'Database',
    guide_tags: ['postgresql', 'indexing', 'advanced'],
    guide_difficulty: 'Advanced',
    guide_author: 'senior.dev',
}

// Beginner guide
const beginnerGuide = new Memo()
beginnerGuide.title = 'Basic PostgreSQL Setup'
beginnerGuide.content = 'Setting up PostgreSQL...'
beginnerGuide.metadata = {
    content_type: 'technical_guide',
    guide_category: 'Database',
    guide_tags: ['postgresql', 'setup', 'beginner'],
    guide_difficulty: 'Beginner',
    guide_author: 'junior.dev',
}
```

### Query

```
"PostgreSQL setup guide"
```

### Expected Ranking Order

1. Advanced guide (difficulty boost for technical queries)
2. Beginner guide (lower difficulty, less boost)

## Test 4: Metadata Combination

### Setup

Create a memo with multiple metadata fields:

```typescript
const combinedIssue = new Memo()
combinedIssue.title = 'Critical Security Vulnerability'
combinedIssue.content = 'SQL injection vulnerability found in login endpoint'
combinedIssue.metadata = {
    content_type: 'jira_issue',
    jira_priority: 'Critical',
    jira_status: 'Open',
    jira_issue_type: 'Security',
    importance: 10,
}
combinedIssue.created_at = new Date('2025-01-15')
combinedIssue.updated_at = new Date('202-01-16')
```

### Query

````
"vulnerability SQL injection"

### Scoring Breakdown
- Vector similarity: 0.70 (example)
- Recency boost: 0.14 (very recent)
- Metadata boost: 0.20 (critical + security + importance)
- Content type: 0.05
- **Final score: 0.70 + 0.14 + 0.20 + 0.05 = 1.09 → clamped to 1.0**

## Verification Steps

1. Create test memos with different metadata
2. Run search queries
3. Check `final_score` in results
4. Verify ranking order matches expectations
5. Check `ranking_factors` for debugging

## Debugging

### Check Ranking Factors
The `ranking_factors` field shows individual component scores:

```typescript
{
    final_score: 0.85,
    ranking_factors: {
        vector_similarity: 0.70,
        recency_boost: 0.12,
        metadata_boost: 0.08,
        content_type_boost: 0.00
    }
}
````

### Common Issues

- **Missing metadata**: Score will rely only on vector similarity
- **Old dates**: Low recency boost
- **Low priority**: Low metadata boost
- **Wrong content_type**: May get inappropriate boosts
