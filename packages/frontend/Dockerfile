# ============================================================
# Stage 1: Install dependencies
# ============================================================
FROM node:24-alpine AS deps

RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/frontend/package.json ./packages/frontend/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# ============================================================
# Stage 2: Build
# ============================================================
FROM node:24-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/frontend/node_modules ./packages/frontend/node_modules

# Copy workspace configuration
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy shared package source and build it
COPY packages/shared ./packages/shared
RUN pnpm --filter @rete/shared build

# Copy frontend source
COPY packages/frontend ./packages/frontend

# Build arguments for environment variables.
# NEXT_PUBLIC 系は build 時にインライン展開され、未設定だと開発デフォルト（localhost）が
# 本番成果物へ黙って焼き込まれる。ref-0087 と同じガード思想＝未設定なら明示的にビルド失敗させる
# （写し元 reference の NEXT_PUBLIC_API_URL には localhost 既定値が残っている＝説明済み差分・cmn-0402 parity）。
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_REFERENCE_APP_URL
ARG DOCKER_BUILD=1

ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_REFERENCE_APP_URL=${NEXT_PUBLIC_REFERENCE_APP_URL}
ENV DOCKER_BUILD=${DOCKER_BUILD}
ENV NEXT_TELEMETRY_DISABLED=1

# 未設定のままビルドすると localhost が成果物へ焼き込まれるため fail-fast で止める。
RUN test -n "$NEXT_PUBLIC_API_BASE_URL" \
  || { echo "NEXT_PUBLIC_API_BASE_URL is required (docker build --build-arg NEXT_PUBLIC_API_BASE_URL=...)" >&2; exit 1; }
RUN test -n "$NEXT_PUBLIC_REFERENCE_APP_URL" \
  || { echo "NEXT_PUBLIC_REFERENCE_APP_URL is required (docker build --build-arg NEXT_PUBLIC_REFERENCE_APP_URL=...)" >&2; exit 1; }

# Ensure public directory exists (may be empty)
RUN mkdir -p /app/packages/frontend/public

# Build frontend (standalone output)
RUN pnpm --filter @rete/frontend build

# ============================================================
# Stage 3: Production
# ============================================================
FROM node:24-alpine AS production

# Add non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy standalone build output
COPY --from=build /app/packages/frontend/.next/standalone ./
COPY --from=build /app/packages/frontend/.next/static ./packages/frontend/.next/static

# Copy public directory if it exists (handled gracefully)
COPY --from=build /app/packages/frontend/public ./packages/frontend/public

# Set ownership
RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1

CMD ["node", "packages/frontend/server.js"]
