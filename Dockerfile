# Stage 1: Build
FROM node:20-alpine AS build
WORKDIR /app

# Copy package files and lib tarballs first for cache efficiency
COPY package.json package-lock.json ./
COPY libs/ libs/
RUN npm ci --ignore-scripts

# Copy source and build
# VITE_BASE_PATH sets the public base path for assets (e.g. /apps/kb/)
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
# Build stamp (CASE-472) — baked from CI --build-arg; 'dev' default hides it.
ARG VITE_BUILD_STAMP=dev
ARG VITE_BUILD_SHA=dev
ENV VITE_BUILD_STAMP=${VITE_BUILD_STAMP}
ENV VITE_BUILD_SHA=${VITE_BUILD_SHA}
COPY . .
RUN npm run build

# Stage 2: Production server
FROM node:20-alpine AS production
WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json ./
COPY libs/ libs/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy server source (run via tsx). Includes server/seed/ + server/prompts/
# which are read at runtime by bootstrap.routes.ts and agent.ts.
COPY server/ server/
# Copy the served KB client bundle (CASE-437) — kb-client.routes.ts reads it at
# runtime to serve GET /server-api/kb-client/{manifest,download,files/:name,install}.
COPY kb-client/ kb-client/
# The case playbook is served with the client (CASE-440) — single source under
# docs/playbooks/, read at runtime by kb-client.routes.ts.
COPY docs/playbooks/case-workflow.md docs/playbooks/case-workflow.md
COPY tsconfig.json ./

# Copy built frontend
COPY --from=build /app/dist dist/

ENV NODE_ENV=production
ENV PORT=3012

EXPOSE 3012

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3012${APP_BASE_PATH:-}/api/health || exit 1

CMD ["npx", "tsx", "server/index.ts"]
