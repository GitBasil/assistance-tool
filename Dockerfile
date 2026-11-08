# Footsteps server: collector, dashboard and the embeddable script, in one image.
# Data (SQLite database, snapshots, recordings) lives in the /data volume.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY bridge ./bridge
RUN node scripts/build.mjs && npm run build:server

FROM node:22-alpine
ENV NODE_ENV=production \
    ASSIST_HOST=0.0.0.0 \
    ASSIST_PORT=7821 \
    ASSIST_DATA_DIR=/data \
    ASSIST_LOG_FORMAT=json
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/build ./build
COPY --from=build /app/dist ./dist
COPY --from=build /app/bridge/dashboard ./bridge/dashboard
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7821
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:7821/ready >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "build/server.mjs"]
