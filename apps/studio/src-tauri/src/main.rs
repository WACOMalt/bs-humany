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

// ---------------------------------------------------------------------------------------------
// The VR viewer: the studio as the publisher.
//
// The page cannot touch tmpfs, so it builds the bridge bytes -- the same codec `pnpm publish:pose`
// uses -- and hands them here in batches to be written in place, one call a frame. The reverse
// channels come back the same way: the grab file's bytes on request, and whatever the panel
// appended to the command log since last asked. And the viewer itself is launched from here,
// pointed at the mesh pack, and stopped on disconnect.
// ---------------------------------------------------------------------------------------------

const BRIDGE_BASE: &str = "/dev/shm/bs-humany-pose";
const BRIDGE_NAMES: [&str; 3] = ["", "-muscles", "-grab"];

#[derive(Default)]
struct Bridges {
    files: std::sync::Mutex<std::collections::HashMap<String, std::fs::File>>,
    commands_read: std::sync::Mutex<u64>,
    viewer: std::sync::Mutex<Option<std::process::Child>>,
}

fn bridge_path(name: &str) -> Result<std::path::PathBuf, String> {
    if !BRIDGE_NAMES.contains(&name) {
        return Err(format!("no bridge file is called '{name}'"));
    }
    Ok(std::path::PathBuf::from(format!("{BRIDGE_BASE}{name}")))
}

/// Create or truncate a bridge file at this many bytes and keep it open.
#[tauri::command]
fn bridge_create(state: tauri::State<'_, Bridges>, name: String, bytes: u64) -> Result<(), String> {
    let path = bridge_path(&name)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    file.set_len(bytes).map_err(|e| e.to_string())?;
    eprintln!("studio: bridge {} open, {bytes} bytes", path.display());
    state.files.lock().unwrap().insert(name, file);
    Ok(())
}

/// Write a batch into a bridge file: the body is `[u32 offset][u32 length][bytes]...`, little
/// endian, written in order -- which is the seqlock's order.
#[tauri::command]
fn bridge_write(state: tauri::State<'_, Bridges>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    use std::os::unix::fs::FileExt;
    let name = request
        .headers()
        .get("x-bridge")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("bridge_write wants the batch as the request body.".into());
    };
    let files = state.files.lock().unwrap();
    let file = files.get(&name).ok_or_else(|| format!("bridge '{name}' is not open"))?;
    let mut at = 0usize;
    while at + 8 <= bytes.len() {
        let offset = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as u64;
        let length = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        at += 8;
        if at + length > bytes.len() {
            return Err("a write runs past the end of the batch".into());
        }
        file.write_all_at(&bytes[at..at + length], offset).map_err(|e| e.to_string())?;
        at += length;
    }
    Ok(())
}

/// A text file beside a bridge: the pose sidecar, the status. Written whole and renamed into
/// place, so a reader never sees half of one.
#[tauri::command]
fn bridge_text(suffix: String, text: String) -> Result<(), String> {
    if !matches!(suffix.as_str(), ".json" | "-status.json") {
        return Err(format!("no bridge text file is called '{suffix}'"));
    }
    let path = format!("{BRIDGE_BASE}{suffix}");
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// The whole of a small bridge file -- the grab channel -- as bytes.
#[tauri::command]
fn bridge_read(name: String) -> Result<tauri::ipc::Response, String> {
    let path = bridge_path(&name)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Whatever the viewer's panel appended to the command log since this was last asked.
#[tauri::command]
fn bridge_commands(state: tauri::State<'_, Bridges>) -> Result<Vec<String>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = format!("{BRIDGE_BASE}-commands.jsonl");
    let Ok(mut file) = std::fs::File::open(&path) else {
        return Ok(Vec::new());
    };
    let mut read = state.commands_read.lock().unwrap();
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size < *read {
        // A viewer that restarted truncated the file; start over from its beginning.
        *read = 0;
    }
    file.seek(SeekFrom::Start(*read)).map_err(|e| e.to_string())?;
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(|e| e.to_string())?;
    // Only whole lines; a partial last line waits for its newline.
    let whole = text.rfind('\n').map(|i| i + 1).unwrap_or(0);
    *read += whole as u64;
    Ok(text[..whole]
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect())
}

/// Close every bridge file and forget the command log's position. The files stay on tmpfs for a
/// viewer still looking at them, except the muscle ring, which a run without muscles must not
/// leave behind.
#[tauri::command]
fn bridge_close(state: tauri::State<'_, Bridges>, remove_muscles: bool) -> Result<(), String> {
    state.files.lock().unwrap().clear();
    *state.commands_read.lock().unwrap() = 0;
    if remove_muscles {
        let _ = std::fs::remove_file(format!("{BRIDGE_BASE}-muscles"));
    }
    Ok(())
}

/// Where the viewer binary is: named outright, beside this executable, or in this repository's
/// build directory when running from a checkout.
fn find_viewer() -> Option<std::path::PathBuf> {
    if let Some(named) = std::env::var_os("BS_HUMANY_XR_VIEWER") {
        return Some(std::path::PathBuf::from(named));
    }
    let name = "bs-humany-xr-viewer";
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let beside = dir.join(name);
            if beside.exists() {
                return Some(beside);
            }
        }
    }
    let checkout = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../xr-viewer/target/release")
        .join(name);
    checkout.exists().then_some(checkout)
}

/// Where the mesh pack is: named outright, bundled with the app, or in the checkout.
fn find_pack(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    if let Some(named) = std::env::var_os("BS_HUMANY_PACK_DIR") {
        return Some(std::path::PathBuf::from(named));
    }
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("assets-anatomical/data");
        if bundled.join("manifest.json").exists() {
            return Some(bundled);
        }
    }
    let checkout = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/assets-anatomical/data");
    checkout.join("manifest.json").exists().then_some(checkout)
}

/// Launch the viewer, following the bridge. Returns what was launched, for the status line.
#[tauri::command]
fn xr_viewer_launch(app: tauri::AppHandle, state: tauri::State<'_, Bridges>) -> Result<String, String> {
    let mut slot = state.viewer.lock().unwrap();
    if let Some(child) = slot.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok("already running".into());
        }
    }
    // Said on the terminal too, because the page's status line is easy to miss and this is the
    // step that depends on the machine: which binary, which pack.
    let viewer = find_viewer().ok_or_else(|| {
        let why = "no bs-humany-xr-viewer found: set BS_HUMANY_XR_VIEWER, or build apps/xr-viewer";
        eprintln!("studio: {why}");
        why.to_string()
    })?;
    let pack = find_pack(&app).ok_or_else(|| {
        let why = "no mesh pack found: set BS_HUMANY_PACK_DIR to packages/assets-anatomical/data";
        eprintln!("studio: {why}");
        why.to_string()
    })?;
    eprintln!(
        "studio: launching {} view --follow {BRIDGE_BASE} --pack {}",
        viewer.display(),
        pack.display()
    );
    let child = std::process::Command::new(&viewer)
        .arg("view")
        .arg("--follow")
        .arg(BRIDGE_BASE)
        .arg("--pack")
        .arg(&pack)
        .spawn()
        .map_err(|e| {
            eprintln!("studio: could not launch the viewer: {e}");
            format!("{}: {e}", viewer.display())
        })?;
    *slot = Some(child);
    Ok(viewer.display().to_string())
}

#[tauri::command]
fn xr_viewer_running(state: tauri::State<'_, Bridges>) -> bool {
    let mut slot = state.viewer.lock().unwrap();
    match slot.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

#[tauri::command]
fn xr_viewer_stop(state: tauri::State<'_, Bridges>) {
    if let Some(mut child) = state.viewer.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    prefer_a_window_that_opens();

    tauri::Builder::default()
        // The dialog plugin is here for its Rust side only: the two commands above call it, and
        // the page cannot. Nothing of it is exposed to JavaScript.
        .plugin(tauri_plugin_dialog::init())
        .manage(Bridges::default())
        .invoke_handler(tauri::generate_handler![
            save_file,
            save_file_set,
            open_text_file,
            bridge_create,
            bridge_write,
            bridge_text,
            bridge_read,
            bridge_commands,
            bridge_close,
            xr_viewer_launch,
            xr_viewer_running,
            xr_viewer_stop
        ])
        .run(tauri::generate_context!())
        .expect("bs-humany studio: the web view failed to start");
}
