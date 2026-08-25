# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- deps
FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --------------------------------------------------------------- build
FROM node:24-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `.env` is deliberately excluded from the build context (see .dockerignore) so
# that no real secret is ever baked into an image layer. `prisma.config.ts`
# still resolves DATABASE_URL when it loads, so the build gets a placeholder:
# neither `prisma generate` nor `next build` opens a connection, and the real
# URL is injected at runtime by Compose.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"

RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ------------------------------------------------------------- migrator
# Migrations and seeding run from here, not from the runtime image. The Prisma
# CLI pulls in a deep dependency tree (@prisma/config -> effect, c12 …) that has
# no business being in the image that serves traffic, and cherry-picking those
# packages into the runner is exactly the kind of thing that breaks silently on
# the next upgrade. This stage already has the full, correct tree.
#
# This stage inherits the builder's placeholder DATABASE_URL. Compose sets the
# real one on the `migrate` service, and a service environment always overrides
# an image ENV — so the placeholder only ever survives if someone runs this
# image with no database configured at all, where it fails to connect loudly
# rather than migrating something unintended.
FROM builder AS migrator
WORKDIR /app
ENV NODE_ENV=production
CMD ["npx", "prisma", "migrate", "deploy"]

# --------------------------------------------------------------- runner
FROM node:24-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The generated Prisma client is declared external, so it is not bundled into
# the standalone output and must be present at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/adapter-pg ./node_modules/@prisma/adapter-pg

# Uploaded attachments. Created here and owned by the runtime user so the
# container can write to it even before Compose mounts a volume over the top;
# with the volume mounted, files survive a rebuild.
ENV PRIO_STORAGE_DIR=/app/storage
RUN mkdir -p /app/storage && chown -R nextjs:nodejs /app/storage
VOLUME ["/app/storage"]

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
