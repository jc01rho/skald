FROM python:3.11-slim

ARG CACHE_BUST=1
RUN echo "Cache bust: $CACHE_BUST"

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy project files
COPY pyproject.toml ./
COPY README.md ./
COPY src/ ./src/

RUN echo "=== DEBUG: source field in docs_collector.py ===" && grep -n "source=" /app/src/skald_worker/collectors/docs_collector.py | head -10

# Install Python dependencies
RUN pip install --no-cache-dir -e .

# Create non-root user
RUN useradd -m -u 1000 worker && chown -R worker:worker /app
USER worker

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Run the application
CMD ["uvicorn", "skald_worker.main:app", "--host", "0.0.0.0", "--port", "8080"]

# Force rebuild - 20260207061201
