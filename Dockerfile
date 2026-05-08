# syntax=docker/dockerfile:1.6
# Multi-stage Dockerfile for market-pulse — Node 20 alpine, ~120 MB image.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Drop privileges. The base image ships with a non-root `node` user.
USER node

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

EXPOSE 3001

# Healthcheck hits /readyz every 30s. The endpoint returns 503 when any
# critical module is down or stale, so the orchestrator restarts a pod that's
# silently degraded (vs. the old /api/health which always returned 200).
# start-period=30s gives news/derivatives a margin to warm up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
