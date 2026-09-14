# Deploying the studio

The studio is a static site: everything runs in the browser, and the server only has to hand
out files with two headers. The repository ships a `Dockerfile` that builds it and serves it
with nginx.

## Build and run

On the machine that will serve it, with Docker or Podman installed:

```bash
git clone https://github.com/WACOMalt/bs-humany.git && cd bs-humany
docker build -t bs-humany-studio .
docker run -d --name bs-humany -p 8080:80 --restart unless-stopped bs-humany-studio
```

Then open `http://<that machine>:8080/`. The same two commands work with `podman` in place of
`docker`. `compose.yaml` does the same as one step: `docker compose up -d --build`.

To update, pull and rebuild:

```bash
git pull && docker build -t bs-humany-studio . && docker rm -f bs-humany && docker run -d --name bs-humany -p 8080:80 --restart unless-stopped bs-humany-studio
```

## What the image contains

- The studio built by `pnpm build:studio`: about 27 MB of files, of which the MuJoCo wasm is
  10 MB and the mesh pack 9 MB plus a 2 MB level of detail that loads first.
- nginx serving them with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, which the app expects (ADR-008, ADR-010), the
  `application/wasm` type, gzip, and a year of caching for the hashed assets.

No data leaves the browser: sessions, recordings and Blender exports are downloads.

## Serving over HTTPS

Cross-origin isolation and `SharedArrayBuffer` need a secure context: `http://localhost` and
plain LAN addresses in most browsers count as insecure except `localhost`. If a browser refuses
the isolated features on a LAN address, put the container behind a reverse proxy that
terminates TLS (Caddy does this with one line per site) and keep the two headers above.
