# bs-humany studio, served as static files.
#
# Stage 1 builds the studio with the pinned pnpm; stage 2 is nginx with the two headers the
# app needs (cross-origin isolation for SharedArrayBuffer, see apps/studio/vite.config.ts) and
# long cache lifetimes for the hashed assets. The image has no server-side state.
#
#   docker build -t bs-humany-studio .
#   docker run -d --name bs-humany -p 8080:80 --restart unless-stopped bs-humany-studio
#
# `podman` accepts the same commands.

FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN pnpm install --frozen-lockfile
RUN pnpm build:studio

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/studio/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
