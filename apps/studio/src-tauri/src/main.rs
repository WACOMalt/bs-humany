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

/// Save bytes the page hands over, wherever a native dialog says to put them.
///
/// A web view is not a browser and does not pretend to be one. `<a download>` and
/// `<input type="file">` are how the container's studio saves and loads, and inside WebKitGTK
/// both are inert -- no download handler, no file chooser -- so in the binary the Save, Load and
/// both Export buttons did nothing at all and said nothing about it.
///
/// The page names the file and hands over the bytes; it does not name a path and never learns the
/// one chosen. That keeps this at what a Save button means rather than at write-anywhere: the
/// dialog is the only thing that decides where a file lands, and it belongs to the person at the
/// keyboard.
///
/// Raw body rather than an argument, because a Blender export is a hundred megabytes and JSON
/// would have to spell every byte of it as a number.
#[tauri::command]
async fn save_file(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("bs-humany.bin")
        .to_owned();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_file wants the file's bytes as the request body.".into());
    };
    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(&name)
        .blocking_save_file()
    else {
        // Cancelled, which is not a failure and should not raise anything at the other end.
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(true)
}

/// Save several files that belong together, into one folder the person picks.
///
/// A Blender export is three files now -- the glTF, the vertex cache the bellies stream from, and
/// the import script -- and none of them is any use without the others. Three save dialogs for
/// one export is three chances to put one of them somewhere else, so this asks for the folder
/// once and writes all three into it under the names the export chose.
///
/// The names are the export's own and are checked to be bare file names: a name with a separator
/// or a parent segment in it is refused rather than joined, so this cannot be talked into writing
/// outside the folder that was picked.
#[tauri::command]
async fn save_file_set(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let header = |k: &str| {
        request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_owned())
    };
    let names: Vec<String> = serde_json::from_str(
        &header("x-file-names").ok_or("save_file_set wants an x-file-names header.")?,
    )
    .map_err(|e| e.to_string())?;
    let sizes: Vec<usize> = serde_json::from_str(
        &header("x-file-sizes").ok_or("save_file_set wants an x-file-sizes header.")?,
    )
    .map_err(|e| e.to_string())?;
    if names.len() != sizes.len() || names.is_empty() {
        return Err("save_file_set wants one size per name, and at least one of each.".into());
    }
    for name in &names {
        let bare = std::path::Path::new(name);
        if bare.components().count() != 1 || name.contains('/') || name.contains('\\') {
            return Err(format!("'{name}' is not a plain file name."));
        }
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_file_set wants the files' bytes as the request body.".into());
    };
    if bytes.len() != sizes.iter().sum::<usize>() {
        return Err("save_file_set was given a body that is not the sizes it was promised.".into());
    }
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(false);
    };
    let folder = folder.into_path().map_err(|e| e.to_string())?;
    let mut at = 0usize;
    for (name, size) in names.iter().zip(sizes.iter()) {
        let path = folder.join(name);
        std::fs::write(&path, &bytes[at..at + size])
            .map_err(|e| format!("{}: {e}", path.display()))?;
        at += size;
    }
    Ok(true)
}

/// Read a file the person picks, as text. `None` when they cancel.
///
/// Sessions only, which is the one thing this application opens. The page does not name a path
/// here either -- it asks for a file and is given what is in it.
#[tauri::command]
async fn open_text_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("bs-humany session", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn main() {
    #[cfg(target_os = "linux")]
    prefer_a_window_that_opens();

    tauri::Builder::default()
        // The dialog plugin is here for its Rust side only: the two commands above call it, and
        // the page cannot. Nothing of it is exposed to JavaScript.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_file, save_file_set, open_text_file])
        .run(tauri::generate_context!())
        .expect("bs-humany studio: the web view failed to start");
}
