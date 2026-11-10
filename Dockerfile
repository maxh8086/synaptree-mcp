# syntax=docker/dockerfile:1
FROM node:22-alpine AS ui
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
# vite.config.js writes to ../src/ui/dist
RUN mkdir -p /app/src/ui && npm run build

FROM node:22-alpine
ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app
COPY package*.json ./
# postinstall runs scripts/setup-egm-bridge.js, so the script must exist before npm ci.
COPY scripts/setup-egm-bridge.js ./scripts/
RUN apk add --no-cache unixodbc git && npm ci --omit=dev
COPY src/ ./src/
COPY client/ ./client/
COPY --from=ui /app/src/ui/dist ./src/ui/dist
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/cli.js", "serve"]
