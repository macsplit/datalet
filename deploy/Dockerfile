# One image serves both the built app and /sync/*, which is what keeps the
# deployable to a single application container plus Redis and Neo4j - and what
# keeps the app same-origin with its sync endpoints, as the Content Security
# Policy's `connect-src 'self'` requires.

# --- build ---
FROM node:22-slim AS build
WORKDIR /app
# Pinned rather than left to corepack's default: package.json carries no
# `packageManager` field, and corepack then wants to confirm a download it
# cannot ask about in a non-interactive build.
ARG PNPM_VERSION=11.18.0
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm build:server
# Drop dev dependencies rather than shipping a build toolchain to a NUC.
RUN pnpm prune --prod

# --- runtime ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# dist/ is the app, server-dist/ the sync server. build:server also copies the
# Lua scripts into server-dist/redis/, which the server reads at startup.
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
USER node
EXPOSE 3000
CMD ["node", "server-dist/index.js"]
