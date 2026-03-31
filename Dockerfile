FROM oven/bun:1-slim

WORKDIR /app

# Git is needed by GitService for diff operations
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Copy workspace config + package files for dependency install
COPY package.json bun.lock ./
COPY packages/api/package.json packages/api/
COPY packages/pipeline/package.json packages/pipeline/

# Install production dependencies
RUN bun install --production --frozen-lockfile

# Copy source code (only api + pipeline, not web)
COPY packages/api/ packages/api/
COPY packages/pipeline/ packages/pipeline/
COPY tsconfig.json ./

EXPOSE 3000

ENV DB_PATH=/data/leyabierta.db
ENV REPO_PATH=/data/leyes

HEALTHCHECK --interval=30s --timeout=3s \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1))" || exit 1

CMD ["bun", "run", "packages/api/src/index.ts"]
