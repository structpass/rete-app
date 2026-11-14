# ============================================================
# Stage 1: Install dependencies
# ============================================================
FROM node:24-alpine AS deps

RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches ./patches
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/

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
COPY --from=deps /app/packages/backend/node_modules ./packages/backend/node_modules

# Copy workspace configuration
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy shared package source and build it
COPY packages/shared ./packages/shared
RUN pnpm --filter @rete/shared build

# Copy backend source
COPY packages/backend ./packages/backend

# Generate Prisma client
RUN pnpm --filter @rete/backend prisma:generate

# Build backend
RUN pnpm --filter @rete/backend build

# 本番 seed 用の JS（runtime へ ts-node を持ち込まないための build 段の成果物）
RUN pnpm --filter @rete/backend prisma:seed:build

# ============================================================
# Stage 3: Production
# ============================================================
FROM node:24-alpine AS production

RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

# Add non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nestjs

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches ./patches
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/

# Copy Prisma schema
COPY --from=build /app/packages/backend/prisma ./packages/backend/prisma
COPY --from=build /app/packages/backend/tsconfig.json ./packages/backend/tsconfig.json

# 本番の bootstrap seed は build 段で JS へ落とした dist-seed を node で実行する
# （runtime へ TypeScript コンパイラを持ち込まないため、ts-node は使わない）。
# アプリ本体と同じく dist から走る。
COPY --from=build /app/packages/backend/dist-seed ./packages/backend/dist-seed

# Install all dependencies, generate Prisma client, then prune to prod only.
# CI=true は pnpm 10 の「TTY が無いまま node_modules を作り直す」確認を止めるため（実測: これが
# 無いと --prod の pruning が ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY で落ち、配布が止まる）。
RUN CI=true pnpm install --frozen-lockfile \
    && CI=true pnpm --filter @rete/backend prisma:generate \
    && CI=true pnpm install --frozen-lockfile --prod

# Copy built shared package
COPY --from=build /app/packages/shared/dist ./packages/shared/dist

# Copy built backend
COPY --from=build /app/packages/backend/dist ./packages/backend/dist

# Set ownership
RUN chown -R nestjs:nodejs /app

USER nestjs

EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/v1/health || exit 1

WORKDIR /app/packages/backend

CMD ["node", "dist/main"]
