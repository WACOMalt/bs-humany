# Deploying the studio

The studio is a static site: everything runs in the browser, and the server only has to hand
out files with two headers. The repository ships a `Dockerfile` that builds it and serves it
with nginx.

The image is not published to any registry. It is two lines to build and it embeds 36 MB of
built files that change whenever the data does, so a registry copy would be a second thing to
keep true rather than a convenience. Build it from the repository at whichever commit you want
to serve.

For one person on one machine, the desktop build in `apps/studio/src-tauri/README.md` is less
ceremony than a container, and it can do the things listed under
[What a served studio cannot do](#what-a-served-studio-cannot-do).

## Build and run

On the machine that will serve it, with Docker installed:

```bash
git clone https://github.com/WACOMalt/bs-humany.git && cd bs-humany
docker build -t bs-humany-studio .
docker run -d --name bs-humany -p 8080:80 --restart unless-stopped bs-humany-studio
```

With Podman, the build needs one flag:

```bash
podman build --format docker -t bs-humany-studio .
podman run -d --name bs-humany -p 8080:80 --restart unless-stopped --health-on-failure=restart bs-humany-studio
```

Podman writes images in the OCI format unless told otherwise, and the OCI format has no field
for a health check, so without `--format docker` the image's `HEALTHCHECK` is dropped with no
more than a warning in the build log. `--health-on-failure=restart` is optional and Podman's
own: it restarts the container when the check fails. Docker has no equivalent for a single
container. Under Docker the check only reports a status (`docker ps` shows `healthy` or
`unhealthy`), and `--restart unless-stopped` restarts the container when nginx exits, not when
the check fails.

Then open `http://<that machine>:8080/`, and read [Secure contexts](#secure-contexts) before
opening it from any machine but that one.

`compose.yaml` does the build and the run as one step: `docker compose up -d --build`. It
declares the same health check on the service, so a container started from it is checked
whichever format its image was built in. `podman compose up -d --build` works too, but
`podman compose` is only a front end: it needs a compose provider, `podman-compose` or
`docker-compose`, installed beside Podman, and fails with "looking up compose provider failed"
without one.

To update, pull and rebuild:

```bash
git pull && docker build -t bs-humany-studio . && docker rm -f bs-humany && docker run -d --name bs-humany -p 8080:80 --restart unless-stopped bs-humany-studio
```

## What the image contains

- The studio built by `pnpm build:studio`: 36 MB of files (36,084,839 bytes, measured at the
  commit that wrote this sentence). Of that, the MuJoCo wasm is 10.2 MB; the body's mesh pack is
  9.2 MB, plus a 2.3 MB level of detail that loads first; the JavaScript is 5.9 MB, most of it
  the studio's own bundle (3.2 MB) and the worker in-window training runs its episodes in
  (2.4 MB); and the Align tab's reference meshes are 7.9 MB, 67 MyoSuite bone meshes with the
  Apache-2.0 licence they may only be redistributed with. The reference meshes are fetched only
  when somebody chooses a reference model in the Align tab. The rest is the page, the landmark
  and site tables and the mesh manifests, about 0.5 MB together.
- nginx serving them with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, which the app uses when available (ADR-008,
  ADR-010), the `application/wasm` type, gzip, and a year of caching for the hashed assets.

The build is the same on every machine that builds one commit. `.dockerignore` keeps local
leftovers out of the build context -- desktop build outputs, training logs, the Align tab's
saved proposals, and old copies of the reference meshes in `apps/studio/public/refMeshes` --
and the reference meshes the image carries are always the tracked originals under
`tools/validate-external/myo_sim`, which the build copies in itself.

To measure it again after the data has changed:

```bash
docker run --rm --entrypoint du bs-humany-studio -sb /usr/share/nginx/html
```

No data leaves the browser: sessions, recordings and Blender exports are downloads.

## Secure contexts

Cross-origin isolation, and `SharedArrayBuffer` with it, is only granted to a secure context.
Over plain HTTP the only secure origins are the machine's own, `localhost` and `127.0.0.1` (and
`[::1]`), so a studio opened as
`http://localhost:8080/` on the serving machine is isolated, and the same studio opened as
`http://192.168.1.20:8080/` from another machine is not: the browser ignores the two headers
there.

The studio does not need `SharedArrayBuffer` today. Its kernel keeps its channels in ordinary
memory (`preferShared: false`) and runs single-threaded MuJoCo, so it works the same on a
non-isolated page. ADR-010 makes that a first-class path rather than a degraded one, because the
platform floor includes phones where isolation cannot be assumed, and ADR-008 keeps the shared
and multi-threaded paths as optimizations for when isolation is there.

On a LAN you trust, plain HTTP is therefore enough. Beyond one, or wherever the traffic should
not be readable on the way, put the container behind a reverse proxy that terminates TLS (Caddy
does this with one line per site) and keep the two headers above; the page is then a secure
context from every address it is opened at.

## What a served studio cannot do

The Brain tab's dashboard features are served by the training dashboard, `pnpm
train:dashboard`, which runs on the viewer's own machine and which the studio reaches at
`http://localhost:5280`. The container does not carry one and should not: the dashboard starts
processes and reads and writes files on the machine it runs on. The features that need it are:

- checkpoints on disk, in the per-user data directory the trainer writes, and handing one over;
- training started from a terminal, or started in the dashboard to use every core;
- the training showcase's activity, the brain drawn live while the showcase plays a run;
- Follow, which shows whatever is publishing on the pose bridge, through the dashboard.

A served studio reaches them only when the viewer runs a dashboard on the same machine and opens
the studio from that machine as `http://localhost:8080/` or `http://127.0.0.1:8080/`: the
dashboard answers only pages served from a loopback address or the desktop app, so a studio
opened by any other address is refused, dashboard or not.

What does work in a served studio: training in the window, which runs its episodes in web
workers inside the page, and checkpoints kept in the browser, which live in that browser's own
storage for that address. Connecting the VR viewer is the desktop app's alone, because the page
cannot start the viewer or write the bridge it reads.
