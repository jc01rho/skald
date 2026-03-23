# Contributing to Skald

We welcome contributions to the Skald codebase from everyone, and we'll do our best to look at issues and PRs as fast as possible. However, as we're a small team, we may take slightly longer than optimal sometimes!

If you intend to work on a larger feature, please submit an issue before you get started on a PR so we can discuss if the feature makes sense.

## Running locally

You can develop locally using the Docker Compose setup shown on the README, but we prefer to run services independently ourselves.

### Pre-requisites

- Have a running Postgres databse with `pgvector` installed
- Have a running Redis server
- Have an OpenAI API key (at the very least)
- Or an Anthropic/Gemini API key if you prefer those providers

### Database setup

If you run Postgres locally, make sure you follow the [pgvector installation instructions](https://github.com/pgvector/pgvector#installation) and then enable the extension on the DB you create, like so:

```sh
createdb skald
psql -d skald
skald=# CREATE EXTENSION vector;
```

You can also run just Postgres via Docker Compose with:

```sh
docker-compose up db
```

If you do this, check out `docker-compose.yml` to understand its configuration.

### Redis setup

We use Redis pub-sub locally for communicating between the express server and the memo processing server. This is a hack that should not be used in production and we're actually likely going to change it soon.

To use Redis, just ensure you have a Redis server running. It should run on `localhost:6379` and in that case you don't even need to configure anything else.

### Environment variables

Your `.env` should have at least the following vars:

```sh
# -------- general config --------
DEBUG=true
EMAIL_VERIFICATION_ENABLED=false
IS_SELF_HOSTED_DEPLOY=true


# -------- stores config --------
DATABASE_URL=<url_of_local_postgres_db>
# REDIS_HOST and REDIS_PORT should also be set if redis is not running on localhost:6379


# -------- llm config --------
LLM_PROVIDER=cli-proxy-api
CLI_PROXY_API_KEY=<your_cli_proxy_key>
CLI_PROXY_API_BASE_URL=<your_cli_proxy_base_url>
GEMINI_API_BASE_URL=<same_value_as_cli_proxy_api_base_url>
LLM_DEFAULT_CHAT_MODEL=<default_chat_model>
LLM_DEFAULT_CLASSIFICATION_MODEL=<default_classification_model>
# or provide a comma-separated fallback chain instead
LLM_FALLBACK_CHAIN=<model-a,model-b,model-c>


# -------- local embedding bridge --------
# backend/src/settings.ts defaults this to http://localhost:8001
EMBEDDING_SERVICE_URL=http://localhost:8001
```

> **Note 1:** The backend currently supports `LLM_PROVIDER=cli-proxy-api`. `CLI_PROXY_API_BASE_URL` and `GEMINI_API_BASE_URL` should point to the same base URL.

### API

We use `pnpm` as our package manager.

From the `backend` directory, run the following commands to set things up:

```sh
pnpm install
pnpm migration:up
```

And then run the API with:

```sh
pnpm dev:express-server
```

The API will be available at `http://localhost:3000`.

### Memo processing server

The memo processing server is a separate service that uses the same codebase as our API. If you've already installed deps for the API no need to do it again.

From inside `backend`, just run:

```sh
pnpm dev:memo-processing-server
```

The memo processing server does not expose any ports and communicates via Redis.

### Frontend

We use `pnpm` as our package manager. From the root dir:

```sh
pnpm install
pnpm run dev
```

The Skald UI will then be available on `http://localhost:5173`.
