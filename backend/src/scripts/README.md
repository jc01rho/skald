# Backend Scripts

This directory contains utility scripts for Skald backend operations.

## Scripts

### reindexAllMemos.ts

Triggers re-embedding of all existing memos.

#### Use Cases

- Deploying new embedding models
- Changing chunking strategies
- Updating embedding configurations
- Refreshing all embeddings with improved settings

#### How It Works

1. **Batch Processing**: Processes memos in batches of 100
2. **Cleanup Phase**:
    - Deletes existing `MemoChunk` records for each memo
    - Deletes existing `MemoSummary` records
3. **Reset Status**:
    - Sets `processing_status = 'received'`
    - Clears any previous error state
    - Clears processing timestamps
4. **Queue for Processing**:
    - Sends memo to RabbitMQ via `sendMemoForAsyncProcessing()`
    - Actual re-embedding happens **asynchronously** in `memo-processing-server`

#### Execution Methods

##### Option 1: Direct Execution (Recommended)

```bash
cd backend
npx tsx src/scripts/reindexAllMemos.ts
```

##### Option 2: Via pnpm (if configured)

```bash
cd backend
pnpm run reindex-all-memos
```

##### Option 3: Inside Kubernetes Pod

```bash
# Find the memo-processing pod
kubectl get pods -n skald -l component=memo-processing

# Execute inside the pod
kubectl exec -it <pod-name> -n skald -- npx tsx src/scripts/reindexAllMemos.ts
```

##### Option 4: Via Docker Container

```bash
docker run --rm \
  -e DATABASE_URL="postgresql://user:pass@host:5432/skald2" \
  -e RABBITMQ_URL="amqp://user:pass@rabbitmq:5672" \
  ghcr.io/jc01rho/skald/backend:latest \
  npx tsx src/scripts/reindexAllMemos.ts
```

#### Prerequisites

Ensure these environment variables are set before execution:

| Variable       | Description                                       |
| -------------- | ------------------------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string                      |
| `RABBITMQ_URL` | RabbitMQ connection string (for async processing) |

#### Example Output

```
Starting reindex of all memos...
Total memos to reindex: 1500
Processing batch 1/15 - count: 100
deletedChunks: 15, deletedSummaries: 1
Memo queued for reprocessing: memo-uuid-1 (1/1500)
Memo queued for reprocessing: memo-uuid-2 (2/1500)
...
Reindex complete - all memos queued for processing
Note: Actual reprocessing happens asynchronously via memo-processing-server
Reindex script completed successfully
```

#### Monitoring Progress

The script only **queues** memos for reprocessing. The actual embedding generation happens in the `memo-processing-server` workers.

```bash
# Watch memo-processing-server logs
kubectl logs -f deployment/memo-processing-server -n skald

# Check memo processing status in database
psql $DATABASE_URL -c "SELECT processing_status, COUNT(*) FROM memos GROUP BY processing_status;"
```

#### Important Notes

1. **Non-destructive**: Doesn't delete the memo itself, only chunks/summaries
2. **Asynchronous**: Actual re-embedding happens in background workers
3. **Batch-safe**: Processes 100 memos at a time with 1s delays between batches
4. **Logging**: Tracks progress (`processed/totalMemos`)
5. **Database Impact**: Search results may be temporarily incomplete until re-embedding completes
6. **Large Datasets**: For thousands of memos, this may take considerable time

#### Integration with Retry/Fallback

All re-embedding operations automatically use the retry and fallback chain from `LLMService.invokeWithRetry()`:

- **Model-level fallback**: Tries 27 models in cli-proxy-api chain
- **Provider-level fallback**: Falls through 8 providers
- **Exponential backoff**: 3 retries per model with 1s, 2s, 3s delays

See [RETRY_FALLBACK_IMPLEMENTATION.md](../../RETRY_FALLBACK_IMPLEMENTATION.md) for details.

#### Script Parameters

| Parameter     | Value  | Description                             |
| ------------- | ------ | --------------------------------------- |
| `BATCH_SIZE`  | 100    | Number of memos processed per batch     |
| `BATCH_DELAY` | 1000ms | Delay between batches (in milliseconds) |

#### Troubleshooting

##### Script Fails to Start

```bash
# Check environment variables are set
echo $DATABASE_URL
echo $RABBITMQ_URL

# Verify database connection
psql $DATABASE_URL -c "SELECT COUNT(*) FROM memos;"
```

##### Memos Not Being Processed

```bash
# Check memo-processing-server is running
kubectl get pods -n skald -l component=memo-processing

# Check RabbitMQ queue
kubectl exec -it deployment/rabbitmq -n skald -- rabbitmqctl list_queues

# Check worker logs for errors
kubectl logs deployment/memo-processing-server -n skald --tail=100
```

##### Duplicate Processing

The script resets `processing_status` to `'received'` before queuing, so it won't queue already-processing memos. If you need to force re-process, update the memo status manually:

```sql
UPDATE memos
SET processing_status = 'received',
    processing_error = NULL,
    processing_started_at = NULL,
    processing_completed_at = NULL
WHERE uuid = 'your-memo-uuid';
```

---

## Adding New Scripts

To add a new script:

1. Create the script file in this directory
2. Add it to `package.json` scripts section:

```json
{
    "scripts": {
        "script-name": "tsx src/scripts/your-script.ts"
    }
}
```

3. Add usage documentation following the template above
4. Ensure proper error handling and logging

## Best Practices

- **Always use DI initialization**: `await initDI()`
- **Use the logger**: Import from `@/lib/logger`
- **Handle cleanup**: Always close DIORM in `finally` block
- **Batch processing**: Process in batches for large datasets
- **Error recovery**: Log errors but continue processing if possible
- **Progress tracking**: Log progress for long-running operations
