FROM oven/bun:1.4.2 AS build
WORKDIR /app
ENV ASTRO_TELEMETRY_DISABLED=1
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY astro.config.mjs tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN bun run check && bun run build

FROM caddy:2.11.4-alpine
COPY ops/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
ENTRYPOINT ["setpriv", "--no-new-privs"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
EXPOSE 80 443
