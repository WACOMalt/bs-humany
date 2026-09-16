# The studio as a desktop application

The same web application the container serves, in a native window instead of a browser tab. The
container stays exactly as it was: this is a second way to run the studio, not a replacement.

What this crate adds is a window and two headers. There are no Tauri commands and no plugins --
the page asks the host for nothing, so it is given nothing.

## Building

```bash
pnpm desktop:build      # the binary alone, which is what most of this is for
pnpm desktop:appimage   # the binary wrapped in an AppImage
pnpm desktop:dev        # a window on the vite dev server, with hot reload
```

Each runs `pnpm build:studio` first, so the bundle in the binary is never stale.

| Command | Output |
| --- | --- |
| `pnpm desktop:build` | `apps/studio/src-tauri/target/release/bs-humany-studio` |
| `pnpm desktop:appimage` | `.../target/release/bundle/appimage/bs-humany-studio_0.0.0_amd64.AppImage` |

The studio's `dist` is about 27 MB -- the MuJoCo wasm, the skeleton meshes and the landmark
tables -- and all of it is embedded in the binary rather than fetched, so the binary is large by
design and needs no network to run.

## What "portable" means here, and what it does not

The bare binary is one file and it will run on another machine **of the same distribution
family**. It is not self-contained: Tauri renders through the system web view, so the binary is
dynamically linked against `libwebkit2gtk-4.1` and `libsoup-3.0`, which are present on a current
Fedora, Nobara, Ubuntu 24.04 or Arch and absent on anything older. `ldd` on the binary says
exactly what it wants.

The AppImage is the answer to that and it is why it is worth having: it carries the web view and
its dependencies with it, so it runs on distributions whose own web view is too old. It is also
about 120 MB rather than about 40. Build the binary for a machine you know and the AppImage for
one you do not.

## Prerequisites

A Rust toolchain and the GTK and web view development packages. Neither is needed to run the
container or the dev server -- only to build this.

```bash
# Rust, into ~/.cargo and ~/.rustup, no root
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Fedora and Nobara
sudo dnf install webkit2gtk4.1-devel libsoup3-devel gtk3-devel openssl-devel \
  curl wget file libappindicator-gtk3-devel librsvg2-devel

# Debian and Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libgtk-3-dev libssl-dev \
  build-essential curl wget file libayatana-appindicator3-dev librsvg2-dev
```

`pnpm desktop:appimage` additionally downloads `linuxdeploy` and an AppImage runtime the first
time it runs, so that one needs a network. `pnpm desktop:build` does not.

## Cross-origin isolation, which is the one thing this shell has to get right

`tauri.conf.json` sets `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on the custom protocol, which is the same pair
`vite.config.ts` serves in development and `docker/nginx.conf` serves in the container.

Without them `crossOriginIsolated` is false, `SharedArrayBuffer` cannot be constructed, and the
kernel falls back to the transferable-`ArrayBuffer` transport. That fallback is a first-class
path and it is tested -- ADR-010 requires it, because `L0` has to run on mobile -- so the window
would work and nobody would notice it was doing more copying than it needed to. Which is the
reason to state the headers rather than discover the question later.

`csp` is left null. The page loads its own wasm and starts its own workers, and a policy written
without measuring which of those it breaks is a policy that gets turned off again the first time
it breaks one.

## The icon

`icons/icon.svg` is the source; the PNGs beside it are rasterised from it:

```bash
cd apps/studio/src-tauri/icons
rsvg-convert -w 32  -h 32  icon.svg -o 32x32.png
rsvg-convert -w 128 -h 128 icon.svg -o 128x128.png
rsvg-convert -w 256 -h 256 icon.svg -o '128x128@2x.png'
rsvg-convert -w 512 -h 512 icon.svg -o icon.png
```

Linux uses only the PNGs. A Windows build would want an `icon.ico` as well, which
`magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico` produces; it is not
committed because nothing here builds for Windows yet and it is a third of a megabyte.
