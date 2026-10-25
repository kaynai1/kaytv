FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY shared shared
COPY server server
COPY web web
# 密钥只在构建期注入前端产物；不传则 TMDB 海报回落、看剧AI 源跳过
ARG VITE_TMDB_API_KEY=
ARG VITE_KANJU_SECRET=
ENV VITE_TMDB_API_KEY=$VITE_TMDB_API_KEY \
    VITE_KANJU_SECRET=$VITE_KANJU_SECRET
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "server/src/index.js"]
