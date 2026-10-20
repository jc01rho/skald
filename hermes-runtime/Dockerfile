# syntax=docker/dockerfile:1.7
ARG PYTHON_BASE=python:3.14.8-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
FROM ${PYTHON_BASE}

ARG HERMES_REVISION=d923a5eb487a17c0a68801bba9ef0f56c81040a8
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
ARG HERMES_DOWNSTREAM_PATCH=patches/d923a5eb-discord.patch
ARG HERMES_DOWNSTREAM_PATCH_SHA256=d51c07a8c0139ea69cdfa400e74bc497a9ed3476d0d3756594f1b1b9ae384d56
# The frozen uv environment is the runtime; never let Hermes 0.22+ re-sync
# dependencies or fetch node/npm/ripgrep from the network at start-up.
ENV HERMES_HOME=/var/lib/hermes \
    HERMES_DISABLE_LAZY_INSTALLS=1 \
    PATH=/opt/bun/bin:/usr/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get upgrade --yes --no-install-recommends \
    && apt-get install --yes --no-install-recommends bash ca-certificates curl git unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --silent --show-error \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
      --output /tmp/bun.zip \
    && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun.zip" | sha256sum --check --strict \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -D -m 0755 /tmp/bun/bun-linux-x64/bun /opt/bun/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip
COPY ${HERMES_DOWNSTREAM_PATCH} /tmp/hermes-downstream.patch
COPY tools/check_discord_role_mention.py /tmp/check_discord_role_mention.py
# Keep complete checkouts, including .git, because upstream update paths inspect
# repository metadata. Verify the exact revision and tracked downstream behavior
# patch before installing the frozen environment; either upstream or patch drift fails.
RUN git clone https://github.com/NousResearch/hermes-agent.git "${HERMES_HOME}/hermes-agent" \
    && git -C "${HERMES_HOME}/hermes-agent" checkout --detach "${HERMES_REVISION}" \
    && test "$(git -C "${HERMES_HOME}/hermes-agent" rev-parse HEAD)" = "${HERMES_REVISION}" \
    && echo "${HERMES_DOWNSTREAM_PATCH_SHA256}  /tmp/hermes-downstream.patch" | sha256sum --check --strict \
    && git -C "${HERMES_HOME}/hermes-agent" apply --check /tmp/hermes-downstream.patch \
    && git -C "${HERMES_HOME}/hermes-agent" apply /tmp/hermes-downstream.patch \
    && cd "${HERMES_HOME}/hermes-agent" \
    && python -m pip install --no-cache-dir uv \
    && UV_PYTHON=/usr/local/bin/python uv sync --frozen --no-dev --extra mcp --extra messaging \
    && UV_PYTHON=/usr/local/bin/python uv pip check --python .venv/bin/python \
    && .venv/bin/python -c 'from plugins.platforms.discord.adapter import DISCORD_AVAILABLE; assert DISCORD_AVAILABLE' \
    && PYTHONPATH=. .venv/bin/python /tmp/check_discord_role_mention.py \
    && rm -rf /root/.cache/uv \
    && rm /tmp/hermes-downstream.patch /tmp/check_discord_role_mention.py \
    && ln -s "${HERMES_HOME}/hermes-agent/.venv/bin/hermes" /usr/local/bin/hermes


RUN groupadd --gid 10001 hermes \
    && useradd --uid 10001 --gid hermes --home-dir "${HERMES_HOME}" --shell /usr/sbin/nologin hermes \
    && mkdir -p "${HERMES_HOME}/logs" "${HERMES_HOME}/sessions" "${HERMES_HOME}/skills" \
    && chown -R hermes:hermes "${HERMES_HOME}"

WORKDIR ${HERMES_HOME}
USER 10001:10001

ENTRYPOINT ["hermes"]
CMD ["gateway", "run"]
