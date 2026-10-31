# resource-as or mcp-sample, from the repo root (the workspaces share one lockfile):
#   docker build -f deploy/service.Dockerfile --build-arg SERVICE=resource-as .
FROM node:26-alpine
ARG SERVICE
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
COPY resource-as/package.json resource-as/
COPY mcp-sample/package.json mcp-sample/
RUN npm ci --omit=dev --ignore-scripts -w ${SERVICE} && npm cache clean --force && mkdir -p /data && chown node:node /data
COPY ${SERVICE}/src ${SERVICE}/src
WORKDIR /app/${SERVICE}
USER node
CMD ["node", "src/index.js"]
