// The desktop shell around the studio, and it is deliberately only that.
//
// Everything the application does happens in the web view: the same bundle `pnpm build:studio`
// produces and the container serves, embedded in the binary rather than fetched. No Tauri
// commands, no plugins, no filesystem or shell access handed to the page -- a body simulator has
// nothing to ask the host for, and the smallest surface is the one with nothing on it.
//
// `windows_subsystem` keeps a console from opening behind the window on Windows. This crate is
// built for Linux today and the attribute costs nothing there.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Ask WebKitGTK not to composite through DMABUF, unless somebody already had an opinion.
///
/// The binary built from this crate opens a window on a KDE Plasma Wayland session and dies
/// immediately: `Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display`. It is
/// WebKitGTK's accelerated compositing path rather than anything here -- the same build runs with
/// `GDK_BACKEND=x11`, which sends it through XWayland instead -- and it is common enough on
/// Wayland compositors and proprietary drivers that most Tauri applications carry this line.
///
/// What it costs is the accelerated path: WebKit hands its buffers over the slower route. What it
/// buys is a window that opens, which is worth more than a fast window that does not, and the
/// studio's own drawing is WebGL inside that buffer rather than the compositing this turns off.
///
/// Only when unset, so `WEBKIT_DISABLE_DMABUF_RENDERER=0` in the environment wins: a machine whose
/// compositor is fine has no reason to take the slow path, and it should not have to rebuild to
/// say so.
#[cfg(target_os = "linux")]
fn prefer_a_window_that_opens() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // Safety: single-threaded, before any Tauri or GTK initialisation has run.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    prefer_a_window_that_opens();

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("bs-humany studio: the web view failed to start");
}
