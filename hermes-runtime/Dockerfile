# syntax=docker/dockerfile:1.7
ARG PYTHON_BASE=python:3.12.13-slim-trixie@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de
FROM ${PYTHON_BASE}

ARG HERMES_REVISION=3c27eb6234bf91b8ceee9e9071591b31e9b148cb
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
ARG HERMES_DOWNSTREAM_PATCH=patches/3c27eb62-no-slash-command-advertising.patch
ARG HERMES_DOWNSTREAM_PATCH_SHA256=8ce4d6b2e89611c281bef69009f59c44124a25ab2eab25fffece1d41e531b185
ENV HERMES_HOME=/var/lib/hermes \
    PATH=/opt/bun/bin:/usr/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
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
    && UV_PYTHON=/usr/local/bin/python uv sync --frozen --no-dev --extra mcp \
    && rm /tmp/hermes-downstream.patch \
    && ln -s "${HERMES_HOME}/hermes-agent/.venv/bin/hermes" /usr/local/bin/hermes


RUN groupadd --gid 10001 hermes \
    && useradd --uid 10001 --gid hermes --home-dir "${HERMES_HOME}" --shell /usr/sbin/nologin hermes \
    && mkdir -p "${HERMES_HOME}/logs" "${HERMES_HOME}/sessions" "${HERMES_HOME}/skills" \
    && chown -R hermes:hermes "${HERMES_HOME}"

WORKDIR ${HERMES_HOME}
USER 10001:10001

ENTRYPOINT ["hermes"]
CMD ["gateway", "run"]
