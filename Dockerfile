# syntax=docker/dockerfile:1.7
# Layout: ARCHITECTURE.md section 4. Design: docs/design/deployment.md section 2.
ARG NODE_IMAGE=node:22.23-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# ---- build: install, compile shared + server + web (+ cli), produce a pruned server tree -------
FROM ${NODE_IMAGE} AS build
ENV CI=true
RUN npm install -g pnpm@10.34.7
WORKDIR /repo
COPY .npmrc pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json   packages/web/
COPY packages/cli/package.json   packages/cli/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build
# pnpm 10 deploy relies on injectWorkspacePackages: true (set in pnpm-workspace.yaml)
RUN pnpm --filter @spoor/server deploy --prod /out \
 && cp -r packages/server/drizzle /out/drizzle \
 && cp -r packages/server/scripts /out/scripts

# ---- model: bake the embedding weights, then prove they load offline --------------------------
FROM build AS model
ARG MODEL_REVISION=761b726dd34fb83930e26aab4e9ac3899aa1fa78
ENV SPOOR_MODEL_DIR=/opt/spoor/models MODEL_REVISION=${MODEL_REVISION}
RUN mkdir -p "$SPOOR_MODEL_DIR" && cd /out && node scripts/fetch-model.mjs

# ---- runtime ---------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production SPOOR_PORT=3000 SPOOR_WEB_DIR=/app/web \
    SPOOR_MIGRATIONS_DIR=/app/drizzle SPOOR_MODEL_DIR=/opt/spoor/models
WORKDIR /app
COPY --from=build --chown=node:node /out /app
COPY --from=build --chown=node:node /repo/packages/web/dist /app/web
COPY --from=model --chown=node:node /opt/spoor/models /opt/spoor/models
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SPOOR_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
