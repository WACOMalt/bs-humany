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

/// Where the studio publishes: its own bridge, not the one the command-line publishers share.
///
/// `DEFAULT_PATH` in `packages/pose-bridge/src/codec.ts` is where `pnpm publish:pose`, the
/// training showcase and the dashboard meet, and where the viewer looks when nobody names a path.
/// It is stated there once and not repeated here. The studio used to publish there too, and a
/// bridge carries one body from one writer, so Connect VR, Start training and Disconnect each
/// deleted or overwrote the files of whichever showcase was running -- the headset froze, and the
/// desktop's Follow said there was no publisher. On a path of its own nothing the studio does can
/// touch another program's files. The viewer it launches is told this path with `--follow`, and a
/// showcase the desktop is following reaches the headset because the studio relays it
/// (`vrLink.ts`), not because the two share files. A test below keeps this apart from
/// `DEFAULT_PATH`.
///
/// tmpfs, so Linux-only: `/dev/shm` is where Linux keeps shared memory as files, which is what
/// lets the viewer map the ring the page writes. Nothing here is meant to run anywhere else.
const BRIDGE_BASE: &str = "/dev/shm/bs-humany-studio";
const BRIDGE_NAMES: [&str; 3] = ["", "-muscles", "-grab"];
/// The largest bridge file the page may ask for. A pose ring for a thousand bones is a few hundred
/// kilobytes and the muscle ring for every belly a few megabytes, so this is far above anything
/// real; it is here so that a bad size from the page is refused rather than taken out of tmpfs,
/// which is memory.
const BRIDGE_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// How many of the viewer's last output lines are kept, for the studio to say why it stopped.
const VIEWER_TAIL_LINES: usize = 20;

/// An open bridge file, and the length it was created at, which every write is held inside.
struct BridgeFile {
    file: std::fs::File,
    len: u64,
}

#[derive(Default)]
struct Bridges {
    files: std::sync::Mutex<std::collections::HashMap<String, BridgeFile>>,
    commands_read: std::sync::Mutex<u64>,
    viewer: std::sync::Mutex<Option<std::process::Child>>,
    /// The viewer's last lines, filled by the threads that drain its output.
    viewer_output: std::sync::Arc<ViewerOutput>,
    /// Whether this process holds the bridge's single-writer claim, so that quitting clears only
    /// files this process wrote.
    claimed: std::sync::Mutex<bool>,
}

#[derive(Default)]
struct ViewerOutput {
    tail: std::sync::Mutex<std::collections::VecDeque<String>>,
    /// Pipes still being read. Once the viewer has exited this reaches zero when its last line is
    /// in `tail`.
    open_pipes: std::sync::atomic::AtomicUsize,
}

fn bridge_path(name: &str) -> Result<std::path::PathBuf, String> {
    if !BRIDGE_NAMES.contains(&name) {
        return Err(format!("no bridge file is called '{name}'"));
    }
    Ok(std::path::PathBuf::from(format!("{BRIDGE_BASE}{name}")))
}

/// A name no other process writes, for a file that is renamed into place: two writers sharing one
/// temporary name is what makes one of the renames fail. The same rule as the Node side's
/// `temporaryName` in `packages/pose-bridge/src/owner.ts`.
fn temporary(path: &std::path::Path) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()))
}

fn header(request: &tauri::ipc::Request<'_>, key: &str) -> Option<String> {
    request
        .headers()
        .get(key)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_owned())
}

/// Walk a batch, `[u32 offset][u32 length][bytes]...` little endian, and hand each write to `put`
/// in order -- which is the seqlock's order.
///
/// The whole batch is checked before anything is written: every write inside the batch, and
/// inside a file of `len` bytes. A batch that failed half way would leave a slot's sequence odd,
/// a frame a reader skips for ever; and a write past the end would grow the file under a viewer
/// that mapped it at the length its header promised.
fn for_each_write(
    batch: &[u8],
    len: u64,
    mut put: impl FnMut(u64, &[u8]) -> std::io::Result<()>,
) -> Result<(), String> {
    let entry = |at: usize| -> Result<(u64, usize), String> {
        let offset = u32::from_le_bytes(batch[at..at + 4].try_into().unwrap()) as u64;
        let length = u32::from_le_bytes(batch[at + 4..at + 8].try_into().unwrap()) as usize;
        if at + 8 + length > batch.len() {
            return Err("a write runs past the end of the batch".into());
        }
        if offset + length as u64 > len {
            return Err(format!(
                "a write of {length} bytes at {offset} runs past the end of a {len}-byte bridge"
            ));
        }
        Ok((offset, length))
    };
    let mut at = 0usize;
    while at + 8 <= batch.len() {
        let (_, length) = entry(at)?;
        at += 8 + length;
    }
    if at != batch.len() {
        return Err("the batch ends part way through a write's header".into());
    }
    at = 0;
    while at + 8 <= batch.len() {
        let (offset, length) = entry(at)?;
        put(offset, &batch[at + 8..at + 8 + length]).map_err(|e| e.to_string())?;
        at += 8 + length;
    }
    Ok(())
}

/// Build a bridge file under a temporary name -- sized, zeroed, the initial batch written -- and
/// rename it into place, keeping it open.
///
/// A new file every time, never the old one truncated. The viewer maps the bridge it follows, and
/// truncating a file under a live mapping is a SIGBUS in the viewer the moment it touches a page
/// that is gone. A rename leaves the old inode, whole, with whoever still has it mapped until they
/// let go; and the file the name points at afterwards is complete from the moment it has that
/// name, header and rest table included, so a reader opening it never sees a file of zeros.
fn create_in_place(
    path: &std::path::Path,
    bytes: u64,
    initial: &[u8],
) -> Result<std::fs::File, String> {
    use std::os::unix::fs::FileExt;
    if bytes > BRIDGE_MAX_BYTES {
        return Err(format!(
            "a {bytes}-byte bridge is larger than the {BRIDGE_MAX_BYTES} bytes any body needs"
        ));
    }
    let tmp = temporary(path);
    let built = (|| {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| format!("{}: {e}", tmp.display()))?;
        file.set_len(bytes).map_err(|e| e.to_string())?;
        for_each_write(initial, bytes, |offset, slice| file.write_all_at(slice, offset))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(file)
    })();
    if built.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    built
}

/// Create a bridge file: `x-bridge` names it, `x-bytes` sizes it, and the body is the initial
/// batch -- the header and the rest table -- in the shape `bridge_write` takes.
///
/// One command rather than a create followed by a first write, so there is no moment at which the
/// file exists without its header.
#[tauri::command]
fn bridge_create(state: tauri::State<'_, Bridges>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let name = header(&request, "x-bridge").unwrap_or_default();
    let bytes: u64 = header(&request, "x-bytes")
        .and_then(|v| v.parse().ok())
        .ok_or("bridge_create wants the file's size in an x-bytes header.")?;
    let tauri::ipc::InvokeBody::Raw(initial) = request.body() else {
        return Err("bridge_create wants the initial batch as the request body.".into());
    };
    let path = bridge_path(&name)?;
    let file = create_in_place(&path, bytes, initial)?;
    eprintln!("studio: bridge {} open, {bytes} bytes", path.display());
    state.files.lock().unwrap().insert(name, BridgeFile { file, len: bytes });
    Ok(())
}

/// Write a batch into a bridge file: the body is `[u32 offset][u32 length][bytes]...`, little
/// endian, written in order -- which is the seqlock's order.
#[tauri::command]
fn bridge_write(state: tauri::State<'_, Bridges>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    use std::os::unix::fs::FileExt;
    let name = header(&request, "x-bridge").unwrap_or_default();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("bridge_write wants the batch as the request body.".into());
    };
    let files = state.files.lock().unwrap();
    let open = files.get(&name).ok_or_else(|| format!("bridge '{name}' is not open"))?;
    for_each_write(bytes, open.len, |offset, slice| open.file.write_all_at(slice, offset))
}

/// A text file beside a bridge: the pose sidecar, the status. Written whole and renamed into
/// place, so a reader never sees half of one.
#[tauri::command]
fn bridge_text(suffix: String, text: String) -> Result<(), String> {
    if !matches!(suffix.as_str(), ".json" | "-status.json") {
        return Err(format!("no bridge text file is called '{suffix}'"));
    }
    let path = std::path::PathBuf::from(format!("{BRIDGE_BASE}{suffix}"));
    let tmp = temporary(&path);
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// The single-writer claim, the same one `packages/pose-bridge/src/owner.ts` makes for the Node
// publishers: a file beside the bridge holding the pid of whoever writes it. A second publisher
// on one path wipes the first one's files and interleaves two bodies into one stream, so the
// studio asks before it clears anything; a claim whose process is gone -- killed rather than
// asked to stop -- is stale, and is taken over.

fn owner_path() -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{BRIDGE_BASE}-owner"))
}

/// Who holds the claim written at `path`, if that is a live process other than this one. Alive
/// means `/proc/<pid>` exists, which is Linux's answer and the only one this needs: the bridge is
/// on tmpfs anyway.
fn owner_at(path: &std::path::Path) -> Option<u32> {
    let pid: u32 = std::fs::read_to_string(path).ok()?.trim().parse().ok()?;
    (pid != std::process::id() && std::path::Path::new(&format!("/proc/{pid}")).exists())
        .then_some(pid)
}

fn bridge_owner() -> Option<u32> {
    owner_at(&owner_path())
}

/// Take the bridge for this process, or say who has it. The page calls this before it clears
/// anything, so a refused Connect touches no file of the program that is using the bridge.
#[tauri::command]
fn bridge_claim(state: tauri::State<'_, Bridges>) -> Result<(), String> {
    if let Some(pid) = bridge_owner() {
        return Err(format!(
            "The studio, a showcase or a publisher (process {pid}) is already using the headset \
             bridge. Stop it (Ctrl-C it, or stop training in the dashboard) and connect again."
        ));
    }
    std::fs::write(owner_path(), format!("{}\n", std::process::id()))
        .map_err(|e| format!("{}: {e}", owner_path().display()))?;
    *state.claimed.lock().unwrap() = true;
    Ok(())
}

/// Give the claim up. Only a claim that still names this process is removed: one taken over
/// since belongs to whoever took it.
fn release_claim(bridges: &Bridges) {
    let path = owner_path();
    let ours = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
        == Some(std::process::id());
    if ours {
        let _ = std::fs::remove_file(&path);
    }
    *bridges.claimed.lock().unwrap() = false;
}

#[tauri::command]
fn bridge_release(state: tauri::State<'_, Bridges>) {
    release_claim(&state);
}

/// Where bs-humany keeps what a person makes with it.
///
/// The directory the operating system means for this, named for the project rather than for the
/// bundle identifier, because somebody who wants to copy a policy to another machine, or keep
/// one, or delete one, has to be able to find it. Tauri would have given
/// `~/.local/share/bsums.xyz.bs-humany.studio`, which nobody is going to type.
///
///   Linux    $XDG_DATA_HOME/bs-humany, or ~/.local/share/bs-humany
///   macOS    ~/Library/Application Support/bs-humany
///   Windows  %APPDATA%\bs-humany
///
/// `tools/train/bin/home.mjs` computes the same path, so the command-line trainer, the dashboard
/// and this binary all read and write one set of checkpoints rather than three. A test holds
/// them in step. `BS_HUMANY_HOME` overrides all of it.
fn data_home() -> Result<std::path::PathBuf, String> {
    if let Ok(over) = std::env::var("BS_HUMANY_HOME") {
        if !over.is_empty() {
            return Ok(std::path::PathBuf::from(over));
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home directory on this machine".to_string())?;
    let home = std::path::PathBuf::from(home);
    if cfg!(target_os = "macos") {
        Ok(home.join("Library").join("Application Support").join("bs-humany"))
    } else if cfg!(target_os = "windows") {
        let base = std::env::var("APPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Roaming"));
        Ok(base.join("bs-humany"))
    } else {
        let base = std::env::var("XDG_DATA_HOME")
            .ok()
            .filter(|v| !v.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("share"));
        Ok(base.join("bs-humany"))
    }
}

fn checkpoint_dir() -> Result<std::path::PathBuf, String> {
    let dir = data_home()?.join("policies");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A checkpoint's file name. The name is checked rather than trusted: it becomes a path.
fn checkpoint_path(name: &str, kind: &str) -> Result<std::path::PathBuf, String> {
    if name.is_empty()
        || name.len() > 40
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("'{name}' is not a checkpoint name"));
    }
    let suffix = match kind {
        "policy" => ".json",
        "centre" => "-centre.json",
        "latest" => "-latest.json",
        _ => return Err(format!("no checkpoint part is called '{kind}'")),
    };
    Ok(checkpoint_dir()?.join(format!("{name}{suffix}")))
}

#[tauri::command]
fn checkpoint_write(name: String, kind: String, text: String) -> Result<(), String> {
    let path = checkpoint_path(&name, &kind)?;
    // Through a temporary and a rename, so a reader never sees half a policy: the trainer
    // rewrites the centre every generation and the studio may be listing them at the time.
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn checkpoint_read(name: String, kind: String) -> Result<Option<String>, String> {
    let path = checkpoint_path(&name, &kind)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Every checkpoint in the directory, by name: the ones with a policy file of their own.
#[tauri::command]
fn checkpoint_list() -> Result<Vec<String>, String> {
    let dir = checkpoint_dir()?;
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let file = entry.file_name();
        let Some(file) = file.to_str() else { continue };
        let Some(stem) = file.strip_suffix(".json") else { continue };
        if stem.ends_with("-centre") || stem.ends_with("-latest") {
            continue;
        }
        names.push(stem.to_string());
    }
    names.sort();
    Ok(names)
}

/// The whole of a small bridge file -- the grab channel -- read twice, back to back, the two
/// copies one after the other in the response. A seqlock needs the sequence read before and
/// after the body, and two reads taken through the page's event loop land a frame apart, which
/// against a writer that rewrites the slot every seven milliseconds is nearly always a mismatch.
/// Taken here they are microseconds apart.
#[tauri::command]
fn bridge_read_pair(name: String) -> Result<tauri::ipc::Response, String> {
    let path = bridge_path(&name)?;
    let mut bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let again = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if again.len() != bytes.len() {
        return Err("the file changed size between reads".into());
    }
    bytes.extend_from_slice(&again);
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

/// The files a session leaves on tmpfs that are to go when one starts or ends, so a viewer never
/// opens the last session's ring and takes it for this one.
///
/// The claim, `-owner`, is never among them: it is given up by `release_claim`, and only when it
/// is still this process's. And while a viewer is running, its two files stay. The viewer holds
/// the grab file and the command log open and writes into them; removing them under it -- which
/// Connect after a page reload did, and the viewer from before the reload was still running --
/// left it writing grabs and panel presses into files nobody could open again, so the headset's
/// hands and buttons went dead with nothing said. The pose and muscle rings can go: the viewer
/// reads those through a mapping that keeps the old inode, and reopens both when the new
/// generation's status appears.
fn clear_suffixes(viewer_alive: bool) -> Vec<&'static str> {
    let mut suffixes = vec!["", ".json", "-muscles", "-status.json"];
    if !viewer_alive {
        suffixes.extend(["-grab", "-commands.jsonl"]);
    }
    suffixes
}

/// Remove the session's files, and any temporary of this process's that a write interrupted
/// between its create and its rename left beside them.
fn bridge_clear_files(viewer_alive: bool) {
    for suffix in clear_suffixes(viewer_alive) {
        let path = std::path::PathBuf::from(format!("{BRIDGE_BASE}{suffix}"));
        let _ = std::fs::remove_file(temporary(&path));
        let _ = std::fs::remove_file(path);
    }
}

fn viewer_alive(bridges: &Bridges) -> bool {
    match bridges.viewer.lock().unwrap().as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

/// Wipe the last session's files before this one writes any.
///
/// With a viewer still running, its command log stays, and reading resumes from where the log
/// ends now: what it holds was said to the last session, and replaying it into this one would
/// press every button the headset pressed before.
#[tauri::command]
fn bridge_clear(state: tauri::State<'_, Bridges>) {
    let alive = viewer_alive(&state);
    state.files.lock().unwrap().clear();
    *state.commands_read.lock().unwrap() = if alive {
        std::fs::metadata(format!("{BRIDGE_BASE}-commands.jsonl"))
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };
    bridge_clear_files(alive);
}

/// Stop writing the muscle ring, for a run that has none, and remove it if asked, so a viewer
/// does not keep drawing the last run's bellies. The pose ring and the command log's position are
/// left alone: this used to close every file and rewind the log, so the next poll handed the
/// studio every command the headset had ever sent, again.
#[tauri::command]
fn bridge_close(state: tauri::State<'_, Bridges>, remove_muscles: bool) -> Result<(), String> {
    state.files.lock().unwrap().remove("-muscles");
    if remove_muscles {
        let _ = std::fs::remove_file(format!("{BRIDGE_BASE}-muscles"));
    }
    Ok(())
}

/// A line from the page's VR link, on the terminal, where the viewer's own lines are.
#[tauri::command]
fn studio_log(message: String) {
    eprintln!("studio: {message}");
}

/// Where the viewer binary is: named outright, beside this executable, or in this repository's
/// build directory when running from a checkout.
///
/// A debug build takes the checkout's viewer over the one beside it when the checkout's is newer.
/// The copy beside a debug executable is not something anybody put there on purpose: `tauri-build`
/// copies the sidecar into `target/debug` when the crate builds, and nothing copies it again when
/// only the viewer changes. So an edit to the viewer, rebuilt with cargo in `apps/xr-viewer`, was
/// invisible to `pnpm desktop:dev` -- Connect VR launched the viewer as it was at the studio's
/// last build, and said so only in a path nobody reads twice. A release build is a tarball or an
/// AppImage whose viewer was shipped beside it, and it keeps that order: the checkout it was built
/// from may not exist on the machine it runs on, and when it does it is not what was released.
fn find_viewer() -> Option<std::path::PathBuf> {
    if let Some(named) = std::env::var_os("BS_HUMANY_XR_VIEWER") {
        return Some(std::path::PathBuf::from(named));
    }
    let name = "bs-humany-xr-viewer";
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .filter(|path| path.exists());
    let checkout = Some(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../xr-viewer/target/release")
            .join(name),
    )
    .filter(|path| path.exists());
    if cfg!(debug_assertions) {
        if let (Some(beside), Some(checkout)) = (&beside, &checkout) {
            let modified = |path: &std::path::Path| path.metadata().and_then(|m| m.modified()).ok();
            if modified(checkout) > modified(beside) {
                return Some(checkout.clone());
            }
        }
    }
    beside.or(checkout)
}

/// Where the mesh pack is: named outright, bundled with the app, or in the checkout.
fn find_pack(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    if let Some(named) = std::env::var_os("BS_HUMANY_PACK_DIR") {
        return Some(std::path::PathBuf::from(named));
    }
    // The tarball: beside the executable. The AppImage: among the resources.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let beside = dir.join("assets-anatomical/data");
            if beside.join("manifest.json").exists() {
                return Some(beside);
            }
        }
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

/// Read one of the viewer's output pipes to its end: every line goes on to this terminal, as it
/// always did, and the last few are kept for the studio to show when the viewer stops.
///
/// Always read, whatever is in it: a pipe nobody drains fills, and a viewer blocked writing a log
/// line into a full pipe stops drawing. Bytes rather than `lines()`, which gives up at the first
/// line that is not UTF-8 and would leave the rest of the pipe to fill.
fn drain_viewer_output(
    pipe: impl std::io::Read + Send + 'static,
    output: std::sync::Arc<ViewerOutput>,
) {
    use std::io::BufRead;
    use std::sync::atomic::Ordering;
    output.open_pipes.fetch_add(1, Ordering::SeqCst);
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(pipe);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&line).trim_end().to_owned();
                    eprintln!("{text}");
                    let mut tail = output.tail.lock().unwrap();
                    if tail.len() == VIEWER_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(text);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        output.open_pipes.fetch_sub(1, Ordering::SeqCst);
    });
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
    // Piped rather than inherited, so the studio can say why the viewer stopped -- no headset, a
    // runtime that refused it -- instead of leaving Connect reading Disconnect over a viewer that
    // is gone. The lines still reach the terminal: the threads pass each one on.
    let mut child = std::process::Command::new(&viewer)
        .arg("view")
        .arg("--follow")
        .arg(BRIDGE_BASE)
        .arg("--pack")
        .arg(&pack)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            eprintln!("studio: could not launch the viewer: {e}");
            format!("{}: {e}", viewer.display())
        })?;
    state.viewer_output.tail.lock().unwrap().clear();
    if let Some(out) = child.stdout.take() {
        drain_viewer_output(out, state.viewer_output.clone());
    }
    if let Some(err) = child.stderr.take() {
        drain_viewer_output(err, state.viewer_output.clone());
    }
    *slot = Some(child);
    Ok(viewer.display().to_string())
}

/// Whether the viewer is running, and if it has stopped, how, and the last it said.
///
/// `code` is the exit status, or null for a viewer a signal ended, when `signal` says which. Once
/// it has exited the tail is taken after the output threads finish -- they reach the end of the
/// pipes moments after the process does -- so the last line is the one it died with, not the one
/// before.
#[tauri::command]
fn xr_viewer_state(state: tauri::State<'_, Bridges>) -> serde_json::Value {
    let exited = match state.viewer.lock().unwrap().as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => None,
            Ok(Some(status)) => Some(status),
            Err(_) => return serde_json::json!({ "running": false, "code": null, "tail": [] }),
        },
        None => return serde_json::json!({ "running": false, "code": null, "tail": [] }),
    };
    let Some(status) = exited else {
        return serde_json::json!({ "running": true, "code": null, "tail": [] });
    };
    let waited = std::time::Instant::now();
    while state.viewer_output.open_pipes.load(std::sync::atomic::Ordering::SeqCst) > 0
        && waited.elapsed() < std::time::Duration::from_millis(250)
    {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    use std::os::unix::process::ExitStatusExt;
    let tail: Vec<String> = state.viewer_output.tail.lock().unwrap().iter().cloned().collect();
    serde_json::json!({
        "running": false,
        "code": status.code(),
        "signal": status.signal(),
        "tail": tail,
    })
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
            bridge_claim,
            bridge_release,
            bridge_create,
            bridge_write,
            bridge_text,
            bridge_read_pair,
            bridge_commands,
            bridge_close,
            bridge_clear,
            checkpoint_write,
            checkpoint_read,
            checkpoint_list,
            xr_viewer_launch,
            xr_viewer_state,
            xr_viewer_stop,
            studio_log
        ])
        .build(tauri::generate_context!())
        .expect("bs-humany studio: the web view failed to start")
        .run(|app, event| {
            // The viewer is this process's child and has no life of its own: when the studio
            // goes, it goes, rather than staying up in the headset printing to a terminal that
            // has moved on.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                let bridges = app.state::<Bridges>();
                if let Some(mut child) = bridges.viewer.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                // Only files this process wrote. A studio that never connected, or whose Connect
                // was refused, quitting must not wipe the bridge of whoever does hold it.
                let claimed = *bridges.claimed.lock().unwrap();
                if claimed {
                    bridge_clear_files(false);
                    release_claim(&bridges);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("bs-humany-studio-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A batch in the page's shape: `[u32 offset][u32 length][bytes]...`.
    fn batch(writes: &[(u32, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (offset, bytes) in writes {
            out.extend_from_slice(&offset.to_le_bytes());
            out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            out.extend_from_slice(bytes);
        }
        out
    }

    #[test]
    fn the_studio_never_publishes_on_the_showcases_path() {
        let codec = include_str!("../../../../packages/pose-bridge/src/codec.ts");
        // Checked to be there first, so a renamed constant fails this rather than passing it.
        assert!(codec.contains("export const DEFAULT_PATH = '"));
        assert!(!codec.contains(&format!("DEFAULT_PATH = '{BRIDGE_BASE}'")));
        assert!(BRIDGE_BASE.starts_with("/dev/shm/"));
    }

    #[test]
    fn a_claim_is_held_only_by_a_live_process_other_than_this_one() {
        let dir = scratch("owner");
        let path = dir.join("owner");
        std::fs::write(&path, format!("{}\n", std::process::id())).unwrap();
        assert_eq!(owner_at(&path), None, "our own claim is not somebody else's");

        let mut gone = std::process::Command::new("true").spawn().unwrap();
        let gone_pid = gone.id();
        gone.wait().unwrap();
        std::fs::write(&path, format!("{gone_pid}\n")).unwrap();
        assert_eq!(owner_at(&path), None, "a process that has been reaped holds nothing");

        let mut live = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        std::fs::write(&path, format!("{}\n", live.id())).unwrap();
        assert_eq!(owner_at(&path), Some(live.id()));
        live.kill().unwrap();
        live.wait().unwrap();

        std::fs::write(&path, "not a pid\n").unwrap();
        assert_eq!(owner_at(&path), None);
        assert_eq!(owner_at(&dir.join("absent")), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_live_viewers_grab_file_and_command_log_are_never_cleared() {
        let alive = clear_suffixes(true);
        assert!(!alive.contains(&"-grab"));
        assert!(!alive.contains(&"-commands.jsonl"));
        for kept in ["", "-muscles", "-status.json"] {
            assert!(alive.contains(&kept));
        }
        let gone = clear_suffixes(false);
        assert!(gone.contains(&"-grab") && gone.contains(&"-commands.jsonl"));
        for suffixes in [alive, gone] {
            assert!(!suffixes.contains(&"-owner"), "the claim is released, never swept up");
        }
    }

    #[test]
    fn the_viewers_output_is_drained_to_the_end_and_its_last_lines_kept() {
        use std::io::Write as _;
        use std::sync::atomic::Ordering;
        // The two pipes are drained by two threads into one tail, so the order in which their
        // lines land is up to the scheduler. If the stderr line could arrive while stdout was
        // still being read, twenty later stdout lines might push it out and the test would fail
        // on a slow machine only. The child therefore closes stdout once it has written it, and
        // writes its stderr line only after the test has seen stdout drained to the end and says
        // so on stdin: the order is fixed by a handshake rather than hoped for from a sleep.
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            // A line that is not UTF-8 in the middle: the rest must still be read.
            .arg(
                "for i in $(seq 1 30); do echo line $i; done; printf 'bad \\377\\n'; exec 1>&-; \
                 read go; echo 'no headset' >&2; exit 3",
            )
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let output = std::sync::Arc::new(ViewerOutput::default());
        drain_viewer_output(child.stdout.take().unwrap(), output.clone());
        drain_viewer_output(child.stderr.take().unwrap(), output.clone());
        let wait_for_open_pipes = |left: usize| {
            let waited = std::time::Instant::now();
            while output.open_pipes.load(Ordering::SeqCst) > left {
                assert!(
                    waited.elapsed() < std::time::Duration::from_secs(5),
                    "a pipe was never drained"
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        };
        // Only stderr is still open once the stdout thread has read every line and seen the end.
        wait_for_open_pipes(1);
        writeln!(child.stdin.take().unwrap(), "go").unwrap();
        assert_eq!(child.wait().unwrap().code(), Some(3));
        wait_for_open_pipes(0);
        let tail = output.tail.lock().unwrap();
        assert_eq!(tail.len(), VIEWER_TAIL_LINES);
        assert!(tail.contains(&"no headset".to_string()));
        assert!(tail.contains(&"line 30".to_string()));
        assert!(tail.iter().any(|line| line.starts_with("bad ")));
        assert!(!tail.contains(&"line 1".to_string()), "only the last lines are kept");
    }

    #[test]
    fn a_batch_is_refused_whole_when_any_write_leaves_the_file() {
        let good = batch(&[(0, &[1, 2, 3, 4]), (12, &[5, 6, 7, 8])]);
        let mut written = Vec::new();
        for_each_write(&good, 16, |offset, bytes| {
            written.push((offset, bytes.to_vec()));
            Ok(())
        })
        .unwrap();
        assert_eq!(written, vec![(0, vec![1, 2, 3, 4]), (12, vec![5, 6, 7, 8])]);

        // The second write runs one byte past a 15-byte file: nothing at all is written, so the
        // first write's odd sequence is never left behind without its even one.
        let mut touched = false;
        let error = for_each_write(&good, 15, |_, _| {
            touched = true;
            Ok(())
        })
        .unwrap_err();
        assert!(error.contains("past the end of a 15-byte bridge"), "{error}");
        assert!(!touched);

        let mut short = batch(&[(0, &[1, 2, 3, 4])]);
        short.truncate(10);
        assert!(for_each_write(&short, 64, |_, _| Ok(())).is_err());
        let mut ragged = batch(&[(0, &[1, 2, 3, 4])]);
        ragged.extend_from_slice(&[0, 0, 0]);
        assert!(for_each_write(&ragged, 64, |_, _| Ok(())).is_err());
    }

    #[test]
    fn every_create_is_a_new_file_and_the_old_one_stays_whole_for_its_reader() {
        use std::io::Read;
        use std::os::unix::fs::MetadataExt;
        let dir = scratch("create");
        let path = dir.join("bridge");
        let first = create_in_place(&path, 16, &batch(&[(0, b"BSHP")])).unwrap();
        let first_ino = std::fs::metadata(&path).unwrap().ino();
        // A reader that opened the first file, the way the viewer maps it.
        let mut reader = std::fs::File::open(&path).unwrap();

        let second = create_in_place(&path, 32, &batch(&[(0, b"NEW!"), (28, b"tail")])).unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        assert_ne!(meta.ino(), first_ino, "a new inode, not the old file truncated");
        assert_eq!(meta.len(), 32);
        let now = std::fs::read(&path).unwrap();
        assert_eq!(&now[..4], b"NEW!");
        assert_eq!(&now[28..], b"tail");

        let mut old = Vec::new();
        reader.read_to_end(&mut old).unwrap();
        assert_eq!(old.len(), 16, "the old file keeps its length under its reader");
        assert_eq!(&old[..4], b"BSHP");
        assert!(!temporary(&path).exists(), "nothing is left under the temporary name");
        drop((first, second));

        assert!(create_in_place(&path, BRIDGE_MAX_BYTES + 1, &[]).is_err());
        assert!(
            create_in_place(&path, 8, &batch(&[(4, b"too long")])).is_err(),
            "an initial batch that leaves the file is refused"
        );
        assert!(!temporary(&path).exists(), "and its temporary is not left behind");
        assert_eq!(std::fs::read(&path).unwrap()[..4], *b"NEW!", "nor the bridge replaced");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
