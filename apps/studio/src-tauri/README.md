# The studio as a desktop application

The same web application the container serves, in a native window instead of a browser tab. The
container stays exactly as it was: this is a second way to run the studio, not a replacement.

What this crate adds is a window, the two headers cross-origin isolation needs (below), the
commands the next section lists, and two things bundled beside the binary: the VR viewer as a
sidecar, and the mesh pack it draws.

## What the page can ask the host for

Nineteen commands, in five families -- every name `generate_handler!` registers in `src/main.rs`,
whose header says the same. None of them takes a path from the page: each family is bounded so
that a page doing its worst reaches only what that family is for.

**File dialogs: `save_file`, `save_file_set`, `open_text_file`.** These are not a preference. A
web view is not a browser: `<a download>` has no download handler behind it and
`<input type="file">` has no file chooser, so in the binary Save, Load and Export clicked and did
nothing and said nothing. They go through a native dialog instead, and the shape keeps that at
what a Save button means. The page hands over file names and the bytes; it does not name a path
and never learns the one chosen, so the dialog is the only thing that decides where a file lands.
`save_file_set` asks for a folder once, because a Blender export is three files that are no use
apart, and it refuses any name that is not a plain file name. `open_text_file` asks for a session
file and hands back its text.

**The VR bridge: `bridge_claim`, `bridge_release`, `bridge_create`, `bridge_write`,
`bridge_text`, `bridge_read_pair`, `bridge_commands`, `bridge_close`, `bridge_clear`.** The page
cannot touch tmpfs, so it builds the bridge bytes and hands them here to be written. The files are
fixed, under `/dev/shm/bs-humany-studio` -- the studio's own bridge, not the one the command-line
publishers share -- and the page chooses among them by name, never by path: a ring is one of
`BRIDGE_NAMES` (the pose ring, `-muscles`, `-grab`), a text file is the `.json` sidecar or the
`-status.json` status, and the viewer's command log and the single-writer claim (`-owner`) have
names of their own. A ring is at most `BRIDGE_MAX_BYTES` (64 MiB), every write in a batch is
checked to lie inside the file at the length it was created with before any of them is made, and a
new ring is built under a temporary name and renamed into place, so a viewer that has the old one
mapped keeps it whole. The page takes the claim before it clears anything, and quitting clears the
bridge only if this process holds it.

**Checkpoints: `checkpoint_write`, `checkpoint_read`, `checkpoint_list`.** The shared data
directory the command-line trainer and the dashboard use too -- `$XDG_DATA_HOME/bs-humany`, or
`~/.local/share/bs-humany`, on Linux, and `BS_HUMANY_HOME` over all of it when it is set. A name
must pass the checkpoint rule (lower-case letters, digits, `-` and `_`, starting with a letter or
a digit, forty at most), because it becomes a file stem, and a part is one of three kinds:
`policy` in `policies/`, `centre` and `latest` in `runs/`.

**The viewer's lifecycle: `xr_viewer_launch`, `xr_viewer_state`, `xr_viewer_stop`.** The viewer
binary and the mesh pack are found by the shell -- from `BS_HUMANY_XR_VIEWER` and
`BS_HUMANY_PACK_DIR`, from beside the executable, or from the checkout, as the sidecar section
below says -- and never named by the page, and the arguments it is started with are fixed.
`xr_viewer_state` says whether it runs and, once it has stopped, its exit code or signal and the
last lines it printed, so the studio can say why. The viewer is killed when the studio exits.

**`studio_log`.** A line from the page's VR link onto the shell's stderr, where the viewer's own
lines are, and nowhere else.

The dialog plugin is registered for its Rust side alone. The crate has no capabilities file, so
none of the plugin's own commands is reachable from JavaScript, and the page has no filesystem or
shell access beyond the nineteen above.

What is bundled comes from `tauri.conf.json`: `bundle.externalBin` names the viewer sidecar
(`binaries/bs-humany-xr-viewer`), and `bundle.resources` carries the mesh pack the viewer draws --
`assets-anatomical/data/manifest.json` and `skeleton.bin` -- together with that pack's own CC BY-SA
`LICENSE` and `NOTICE`, under `assets-anatomical/`.

## Building

```bash
pnpm desktop:build      # the binary alone, which is what most of this is for
pnpm desktop:appimage   # the binary wrapped in an AppImage
pnpm desktop:tarball    # desktop:build, then the release tarball in dist-release/
pnpm desktop:dev        # a window on the vite dev server, with hot reload
```

Every one of them runs `pnpm desktop:sidecar` first -- see the next section for why it cannot be
skipped. After that, `desktop:build` and `desktop:appimage` build the bundle with
`pnpm build:studio`, so the bundle in the binary is never stale; `desktop:dev` builds no bundle
and starts the vite dev server instead (`pnpm -w run dev`), which is where its hot reload comes
from.

| Command | Output | Built |
| --- | --- | --- |
| `pnpm desktop:build` | `target/release/bs-humany-studio` | 16.4 MB |
| `pnpm desktop:appimage` | `target/release/bundle/appimage/bs-humany-studio_0.2.0_amd64.AppImage` | 128 MB |
| `pnpm desktop:tarball` | `dist-release/bs-humany-studio-0.2.0-linux-x86_64.tar.gz` | 20.7 MB |

The studio's `dist` is about 39 MB -- the MuJoCo wasm, the skeleton meshes, the landmark tables,
and the Align tab's 8 MB of reference meshes when `pnpm sync:ref-meshes` has put them there --
and all of it is embedded in the binary rather than fetched, so nothing is downloaded at run
time. Tauri compresses it on the way in, which is why 39 MB of assets plus a web view shell comes
out at a little over sixteen. The figures are from 26 September 2026 and move with the bundle.

The tarball is what the root README promises beside the AppImage: the studio, the VR viewer, the
mesh pack the viewer draws, the repository's `LICENSE` and `NOTICE`, the mesh pack's own CC BY-SA
`LICENSE` and `NOTICE` under `assets-anatomical/`, and a `README.txt` written from
`tools/cli/bin/desktop-tarball-readme.txt`. `tools/cli/bin/desktop-tarball.mjs` stages it in
`dist-release/stage/`, clears the stage once the archive is written, and refuses to write it at
all if any of those is missing. The AppImage carries the same two licence files, at
`usr/lib/bs-humany-studio/assets-anatomical/`, beside the pack they cover.

## The VR viewer sidecar

**Connect VR viewer** launches `bs-humany-xr-viewer`, the native OpenXR viewer in
`apps/xr-viewer`, and hands it the mesh pack. Tauri ships it as a sidecar:
`tauri.conf.json` lists it under `bundle.externalBin`, and for that entry Tauri wants a file
named `binaries/bs-humany-xr-viewer-<host triple>` -- `x86_64-unknown-linux-gnu` on the machine
this was written on, and whatever the `host:` line of `rustc -vV` says on yours.

`pnpm desktop:sidecar` makes that file: it builds the viewer in release, asks `rustc` for the
triple, and copies the binary into `binaries/` under the name Tauri expects. It needs Rust and
nothing else -- none of the web view packages below. The directory is gitignored, because it
holds a build product, and `tauri-build` refuses to build the crate without it, in `tauri dev`
as much as in a release: on a fresh clone `desktop:dev` used to stop in `build.rs` with
`resource path ... doesn't exist` before a window opened. That is why every desktop script runs
it first, and why it is not a placeholder file -- the shell looks beside its own executable first
and would launch the placeholder. The copy goes through a temporary file and a rename, so it can
replace a viewer that is still running from the last session.

Where the shell looks for the viewer, in order: `BS_HUMANY_XR_VIEWER` if it is set; beside its
own executable, which is where Tauri puts the sidecar in `target/`, in the tarball and in the
AppImage; then the checkout's `apps/xr-viewer/target/release`. A debug build -- `desktop:dev` --
takes the checkout's over the one beside it whenever the checkout's is newer, because the copy in
`target/debug` is only refreshed when the studio crate rebuilds, and an edit to the viewer alone
would otherwise not reach the headset. The mesh pack is `BS_HUMANY_PACK_DIR` if set, then
`assets-anatomical/data` beside the executable (the tarball), then among the bundled resources
(the AppImage), then the checkout's `packages/assets-anatomical/data`.

So the bare binary runs the studio on its own, but Connect VR needs `bs-humany-xr-viewer` and
`assets-anatomical/data` beside it, which is the reason the tarball carries both rather than the
binary alone.

## What "portable" means here, and what it does not

The bare binary is one file and it will run on another machine **of the same distribution
family**. It is not self-contained: Tauri renders through the system web view, so the binary is
dynamically linked against `libwebkit2gtk-4.1` and `libsoup-3.0`, which are present on a current
Fedora, Nobara, Ubuntu 24.04 or Arch and absent on anything older. `ldd` on the binary says
exactly what it wants.

The AppImage is the answer to that and it is why it is worth having: it carries the web view and
its dependencies with it, so it runs on distributions whose own web view is too old. It is 128 MB
against 16.4. Build the binary for a machine you know and the AppImage for one you do not.

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
