FROM oven/bun:1-slim

WORKDIR /app

# Git is needed by GitService for diff operations.
# gcc is needed to compile the SIMD shared library used by the RAG vector
# search backend. We keep it after the build so on-host rebuilds (e.g.
# during incident response) work without rebuilding the image.
RUN apt-get update && apt-get install -y git gcc libc6-dev && rm -rf /var/lib/apt/lists/*

# Copy workspace config + package files for dependency install
COPY package.json bun.lock ./
COPY packages/api/package.json packages/api/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/web/package.json packages/web/

# Install production dependencies
RUN bun install --frozen-lockfile

# Copy source code (only api + pipeline + shared, not web)
COPY packages/api/ packages/api/
COPY packages/pipeline/ packages/pipeline/
COPY packages/shared/ packages/shared/
COPY tsconfig.json ./

# Build the SIMD shared lib for linux/amd64 (AVX2 + FMA).
# The RAG vector search loads this via Bun.dlopen at runtime; if missing,
# pipeline.ts falls back to the JS implementation transparently.
RUN gcc -O3 -mavx2 -mfma -shared -fPIC \
    -o packages/api/src/services/rag/vector-simd.linux-amd64.so \
    packages/api/src/services/rag/vector-simd.c

EXPOSE 3000

ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
ENV DB_PATH=/data/leyabierta.db
ENV REPO_PATH=/data/leyes

# Symlink so pipeline's default ./data resolves to the mounted volume
RUN ln -sf /data /app/data

# Run as non-root user
RUN addgroup --gid 1001 app && adduser --uid 1001 --gid 1001 --disabled-password --gecos "" app \
    && chown -R app:app /app \
    && mkdir -p /data && chown app:app /data

USER app
RUN git config --global --add safe.directory /data/leyes \
    && git config --global user.name "Ley Abierta" \
    && git config --global user.email "bot@leyabierta.es"

HEALTHCHECK --interval=30s --timeout=3s \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1))" || exit 1

CMD ["bun", "run", "packages/api/src/index.ts"]
