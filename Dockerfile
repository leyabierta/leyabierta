FROM oven/bun:1-slim

WORKDIR /app

# Git is needed by GitService for diff operations
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* \
    && git config --global --add safe.directory /data/leyes

# Copy workspace config + package files for dependency install
COPY package.json bun.lock ./
COPY packages/api/package.json packages/api/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/web/package.json packages/web/

# Install production dependencies
RUN bun install --frozen-lockfile

# Copy source code (only api + pipeline, not web)
COPY packages/api/ packages/api/
COPY packages/pipeline/ packages/pipeline/
COPY tsconfig.json ./

EXPOSE 3000

ENV DB_PATH=/data/leyabierta.db
ENV REPO_PATH=/data/leyes

# Symlink so pipeline's default ./data resolves to the mounted volume
RUN ln -sf /data /app/data

HEALTHCHECK --interval=30s --timeout=3s \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1))" || exit 1

CMD ["bun", "run", "packages/api/src/index.ts"]
