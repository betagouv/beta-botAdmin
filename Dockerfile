# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git jq tree && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps (tsx is a production dep used by the dev/cli scripts)
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev --ignore-scripts
# Reuse the pre-built SDK lib from builder instead of recompiling
COPY --from=builder /app/node_modules/matrix-bot-sdk/lib ./node_modules/matrix-bot-sdk/lib
# Download only the platform-specific native crypto binary
RUN node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist
COPY src ./src

# Create /data owned by the node user before dropping privileges
RUN mkdir -p /data && chown node:node /data

# Drop to non-root user
USER node

# Volume for runtime data (Matrix session + crypto store)
VOLUME ["/data"]

CMD ["node", "dist/src/index.js"]
