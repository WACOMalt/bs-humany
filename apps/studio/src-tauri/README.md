# The studio as a desktop application

The same web application the container serves, in a native window instead of a browser tab. The
container stays exactly as it was: this is a second way to run the studio, not a replacement.

What this crate adds is a window, two headers, and two commands for saving and opening files.

The commands are not a preference. A web view is not a browser: `<a download>` has no download
handler behind it and `<input type="file">` has no file chooser, so in the binary Save, Load and
Export clicked and did nothing and said nothing. They go through a native dialog instead.

The shape keeps that at what a Save button means. The page hands over file names and the bytes;
it does not name a path and never learns the one chosen, so the dialog is the only thing that
decides where a file lands. `save_file_set` asks for a folder once, because a Blender export is
three files that are no use apart, and it refuses any name that is not a plain file name. Nothing
else is exposed -- the dialog plugin is registered for its Rust side alone and no part of it is
reachable from JavaScript.

## Building

```bash
pnpm desktop:build      # the binary alone, which is what most of this is for
pnpm desktop:appimage   # the binary wrapped in an AppImage
pnpm desktop:dev        # a window on the vite dev server, with hot reload
```

Each runs `pnpm build:studio` first, so the bundle in the binary is never stale.

| Command | Output | Built |
| --- | --- | --- |
| `pnpm desktop:build` | `target/release/bs-humany-studio` | 11.5 MB |
| `pnpm desktop:appimage` | `target/release/bundle/appimage/bs-humany-studio_0.0.0_amd64.AppImage` | 112 MB |

The studio's `dist` is about 27 MB -- the MuJoCo wasm, the skeleton meshes and the landmark
tables -- and all of it is embedded in the binary rather than fetched, so nothing is downloaded at
run time. Tauri compresses it on the way in, which is why 27 MB of assets plus a web view shell
comes out at eleven and a half.

## What "portable" means here, and what it does not

The bare binary is one file and it will run on another machine **of the same distribution
family**. It is not self-contained: Tauri renders through the system web view, so the binary is
dynamically linked against `libwebkit2gtk-4.1` and `libsoup-3.0`, which are present on a current
Fedora, Nobara, Ubuntu 24.04 or Arch and absent on anything older. `ldd` on the binary says
exactly what it wants.

The AppImage is the answer to that and it is why it is worth having: it carries the web view and
its dependencies with it, so it runs on distributions whose own web view is too old. It is 112 MB
against 11.5. Build the binary for a machine you know and the AppImage for one you do not.

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

## Two things that had to be worked around, and why they are where they are

**`NO_STRIP=true`, in the `desktop:appimage` script.** linuxdeploy carries its own `strip` and
that copy is old enough not to know `.relr.dyn`, the compact relocation section current Fedora
libraries are built with. It does not skip what it cannot read -- it fails the bundle, on about
thirty libraries in a row, and the error Tauri prints is `failed to run linuxdeploy` with none of
that in it. Nothing needs stripping here anyway: the binary is already stripped by the release
profile, and the libraries linuxdeploy copies in are the distribution's own.

**`WEBKIT_DISABLE_DMABUF_RENDERER`, set in `main.rs` when the environment has not set it.** Built
without it, the binary opens a window on a KDE Plasma Wayland session and dies at once with
`Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display`. It is WebKitGTK's
accelerated compositing path rather than anything in this crate -- the same build runs under
`GDK_BACKEND=x11`, which routes it through XWayland -- and it is common enough across Wayland
compositors and proprietary drivers that most Tauri applications carry the same line.

What it turns off is WebKit's fast route for handing its buffers to the compositor, which is not
the same thing as the studio's own drawing: that is WebGL inside the buffer. Set
`WEBKIT_DISABLE_DMABUF_RENDERER=0` to take the accelerated path on a machine where it works --
the environment wins, which is the point of only setting it when it is unset.

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
