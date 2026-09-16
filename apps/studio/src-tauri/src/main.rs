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

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("bs-humany studio: the web view failed to start");
}
