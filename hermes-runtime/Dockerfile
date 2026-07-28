# syntax=docker/dockerfile:1.7
ARG PYTHON_BASE=python:3.12.13-slim-trixie@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de
FROM ${PYTHON_BASE}

ARG HERMES_REVISION=339d968689a3b91c5f537d7198ff28abde32ab3b
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
ARG HERMES_SECURITY_PATCH=patches/339d9686-security-dependencies.patch
ARG HERMES_SECURITY_PATCH_SHA256=d18804befcf11d2761a3126d47967b2b0410758b8020e094ef49fc28b7418d84
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
COPY ${HERMES_SECURITY_PATCH} /tmp/hermes-security.patch
# Keep complete checkouts, including .git, because both upstream update paths inspect
# repository metadata. Verify the exact revision and tracked downstream dependency
# patch before installing the frozen environment; either upstream or patch drift fails.
RUN git clone https://github.com/NousResearch/hermes-agent.git "${HERMES_HOME}/hermes-agent" \
    && git -C "${HERMES_HOME}/hermes-agent" checkout --detach "${HERMES_REVISION}" \
    && test "$(git -C "${HERMES_HOME}/hermes-agent" rev-parse HEAD)" = "${HERMES_REVISION}" \
    && echo "${HERMES_SECURITY_PATCH_SHA256}  /tmp/hermes-security.patch" | sha256sum --check --strict \
    && git -C "${HERMES_HOME}/hermes-agent" apply --check /tmp/hermes-security.patch \
    && git -C "${HERMES_HOME}/hermes-agent" apply /tmp/hermes-security.patch \
    && cd "${HERMES_HOME}/hermes-agent" \
    && python -m pip install --no-cache-dir uv \
    && uv sync --frozen --no-dev \
    && rm /tmp/hermes-security.patch \
    && ln -s "${HERMES_HOME}/hermes-agent/.venv/bin/hermes" /usr/local/bin/hermes


RUN groupadd --gid 10001 hermes \
    && useradd --uid 10001 --gid hermes --home-dir "${HERMES_HOME}" --shell /usr/sbin/nologin hermes \
    && mkdir -p "${HERMES_HOME}/logs" "${HERMES_HOME}/sessions" "${HERMES_HOME}/skills" \
    && chown -R hermes:hermes "${HERMES_HOME}"

WORKDIR ${HERMES_HOME}
USER 10001:10001

ENTRYPOINT ["hermes"]
CMD ["gateway", "run"]
