# Uruchomienie portalu

Portal jest statycznym buildem Astro. Publiczny adres to `https://auth.lomi.dev`.
Kontener Caddy serwuje `dist/` i kieruje `/api/auth/*`, `/v1/*`, `/health/*` do
prywatnego API. Sekrety GitHuba i PostgreSQL nigdy nie są częścią tego obrazu.

Pełna procedura dla obu repozytoriów znajduje się w
[`auth-app/DEPLOYMENT.md`](https://github.com/lomi-dev/auth-app/blob/main/DEPLOYMENT.md)
(wymaga dostępu do prywatnego repozytorium API).

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
docker build -t lomi-auth-portal:local .
```

Development: `bun run dev`, adres `http://localhost:4321`; Vite proxy kieruje
żądania do API na `127.0.0.1:3001`. Używaj `localhost` konsekwentnie, ponieważ
`127.0.0.1` stanowi inny origin. `astro preview` nie zastępuje produkcyjnego proxy.

`AUTH_SITE` konfiguruje adres Caddy; domyślnie `auth.lomi.dev` z automatycznym TLS.
`AUTH_UPSTREAM` wskazuje prywatny backend; domyślnie `api:3001`. Nie umieszczaj
CDN/proxy przed tym kontenerem bez odrębnego ustalenia zaufanych adresów IP:
Caddy nadpisuje nagłówek klienta adresem bezpośredniego połączenia.

Nie włączaj access logów na stronach autoryzacji. Nie dodawaj zewnętrznych skryptów,
analizy ruchu, service workera ani cache dla odpowiedzi zawierających sesję.
CSP wymaga skryptów i CSS z własnego origin. Nie dodawaj `unsafe-inline`.

Konfigurację sprawdź przez `caddy validate --config /etc/caddy/Caddyfile` w obrazie.
Po wdrożeniu przetestuj GitHub, device flow i odwołanie sesji w prawdziwej aplikacji.
Sama kompilacja nie potwierdza konfiguracji OAuth ani działania TLS/DNS.

Źródła: [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[Caddy file_server](https://caddyserver.com/docs/caddyfile/directives/file_server),
[oficjalny obraz Caddy](https://hub.docker.com/_/caddy).
