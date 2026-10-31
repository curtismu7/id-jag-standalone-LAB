# Build the web app, then run the API server, which also serves web/dist.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci
COPY web web
RUN npm run build -w web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4720 DATA_DIR=/data
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci --omit=dev -w server && npm cache clean --force && mkdir -p /data && chown node:node /data
COPY server/src server/src
COPY demo demo
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 4720
CMD ["node", "server/src/index.js"]
