# The cloud machine (src/cloud.ts): `ky runner cloud` with what tasks need, as a personal computer
# would have it. Built for linux/amd64 by .github/workflows/image.yml, from the repo's root, after
# `pnpm compile linux-x64` left dist/bin/ky-linux-x64.
#
# The layers go from what changes least to most, and the workflow caches them: a rebuild for a ky
# change makes only the last layer new, so `ky deploy` copies only that one into the account's
# registry (cli/image.ts skips every blob already there). The workflow passes the tools' current
# versions, so their layer is rebuilt when one is released, not on every build.
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG PNPM_VERSION=10
ARG BUN_VERSION=1.3.13

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssh-client procps unzip xz-utils \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Tasks run as ky, in its home: what a sleep saves is under it (src/cloud.ts, cli/runner/cloud.ts).
RUN useradd --create-home --home-dir /home/ky --shell /bin/bash ky

RUN npm install --global --no-audit --no-fund \
       "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" "pnpm@${PNPM_VERSION}" \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" \
    && npm cache clean --force

USER ky
WORKDIR /home/ky
ENV HOME=/home/ky
EXPOSE 8080
ENTRYPOINT ["ky", "runner", "cloud"]

COPY --chmod=755 dist/bin/ky-linux-x64 /usr/local/bin/ky
