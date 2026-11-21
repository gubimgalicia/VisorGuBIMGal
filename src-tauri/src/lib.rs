//! VisorGuBIMGal Tauri v2 Windows desktop host (E1–E4, T-169).
//!
//! - Single instance: a second `.ifc` double-click forwards the file to the running window.
//! - Local-file streaming protocol (`gubim-file`): serves only explicitly authorized local `.ifc`
//!   files as raw `application/octet-stream` bytes so large models (184+ MB) never cross JSON IPC.
//! - Native open/save file dialogs backed by `tauri-plugin-dialog`.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

#[derive(Debug, Clone, Serialize)]
pub struct DesktopFileToken {
    pub token: String,
    pub name: String,
    pub size: u64,
}

#[derive(Default)]
struct FileRegistry {
    next_id: AtomicU64,
    paths: Mutex<HashMap<String, PathBuf>>,
}

impl FileRegistry {
    fn register(&self, path: &Path) -> Option<DesktopFileToken> {
        let canonical = fs::canonicalize(path).ok()?;
        let meta = fs::metadata(&canonical).ok()?;
        if !meta.is_file() {
            return None;
        }
        let name = canonical
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("modelo.ifc")
            .to_string();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let token = format!("f-{id}");
        if let Ok(mut guard) = self.paths.lock() {
            guard.insert(token.clone(), canonical);
        }
        Some(DesktopFileToken {
            token,
            name,
            size: meta.len(),
        })
    }

    fn resolve(&self, token: &str) -> Option<PathBuf> {
        self.paths.lock().ok()?.get(token).cloned()
    }
}

#[derive(Default)]
struct PendingFiles {
    queue: Mutex<Vec<DesktopFileToken>>,
}

impl PendingFiles {
    fn push(&self, item: DesktopFileToken) {
        if let Ok(mut guard) = self.queue.lock() {
            guard.push(item);
        }
    }

    fn take_all(&self) -> Vec<DesktopFileToken> {
        self.queue
            .lock()
            .map(|mut guard| std::mem::take(&mut *guard))
            .unwrap_or_default()
    }
}

fn is_ifc_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("ifc"))
        .unwrap_or(false)
}

fn collect_ifc_args<I, S>(args: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .filter_map(|raw| {
            let trimmed = raw.as_ref().trim().trim_matches('"');
            if trimmed.is_empty() || trimmed.starts_with('-') {
                return None;
            }
            let p = PathBuf::from(trimmed);
            (is_ifc_path(&p) && p.is_file()).then_some(p)
        })
        .collect()
}

fn decode_percent(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn take_pending_files(pending: State<'_, PendingFiles>) -> Vec<DesktopFileToken> {
    pending.take_all()
}

#[tauri::command]
fn register_ifc_path(path: String, registry: State<'_, FileRegistry>) -> Option<DesktopFileToken> {
    let p = PathBuf::from(path);
    if !is_ifc_path(&p) {
        return None;
    }
    registry.register(&p)
}

#[tauri::command]
async fn pick_ifc_file(
    app: AppHandle,
    registry: State<'_, FileRegistry>,
) -> Result<Option<DesktopFileToken>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Modelos IFC", &["ifc", "IFC"])
        .blocking_pick_file();

    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path_buf = match file_path {
        FilePath::Path(p) => p,
        FilePath::Url(url) => url
            .to_file_path()
            .map_err(|_| "Ruta de archivo no valida.".to_string())?,
    };
    Ok(registry.register(&path_buf))
}

#[tauri::command]
async fn save_exported_file(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<bool, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("Se esperaban bytes binarios para guardar el archivo.".to_string());
        }
    };

    let header_str = |key: &str| -> String {
        request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .map(decode_percent)
            .unwrap_or_default()
    };

    let default_name = header_str("x-gubim-filename");
    let filter_name = header_str("x-gubim-filter-name");
    let ext_csv = header_str("x-gubim-extensions");
    let extensions: Vec<String> = ext_csv
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let mut builder = app.dialog().file();
    if !default_name.is_empty() {
        builder = builder.set_file_name(&default_name);
    }
    if !extensions.is_empty() {
        let ext_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
        let label = if filter_name.is_empty() {
            "Archivo"
        } else {
            filter_name.as_str()
        };
        builder = builder.add_filter(label, &ext_refs);
    }

    let Some(target) = builder.blocking_save_file() else {
        return Ok(false);
    };
    let path_buf = match target {
        FilePath::Path(p) => p,
        FilePath::Url(url) => url
            .to_file_path()
            .map_err(|_| "Ruta de destino no valida.".to_string())?,
    };
    fs::write(&path_buf, &bytes).map_err(|e| format!("Error al escribir archivo: {e}"))?;
    Ok(true)
}

pub fn run() {
    tauri::Builder::default()
        .manage(FileRegistry::default())
        .manage(PendingFiles::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second double-click on an .ifc file: focus existing window and forward files.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let registry = app.state::<FileRegistry>();
            for path in collect_ifc_args(&argv) {
                if let Some(token) = registry.register(&path) {
                    let _ = app.emit("gubim://open-file", token);
                }
            }
        }))
        .register_uri_scheme_protocol("gubim-file", |ctx, request| {
            if request.method() == tauri::http::Method::OPTIONS {
                return Response::builder()
                    .status(StatusCode::NO_CONTENT)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, OPTIONS")
                    .body(Vec::new())
                    .unwrap();
            }

            let raw_path = request.uri().path().trim_start_matches('/');
            let token = decode_percent(raw_path);
            let registry = ctx.app_handle().state::<FileRegistry>();
            let Some(file_path) = registry.resolve(&token) else {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(b"Not found".to_vec())
                    .unwrap();
            };

            match fs::read(&file_path) {
                Ok(bytes) => Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "application/octet-stream")
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::CACHE_CONTROL, "no-store")
                    .body(bytes)
                    .unwrap(),
                Err(_) => Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(b"Read error".to_vec())
                    .unwrap(),
            }
        })
        .setup(|app| {
            let registry = app.state::<FileRegistry>();
            let pending = app.state::<PendingFiles>();
            for path in collect_ifc_args(std::env::args()) {
                if let Some(token) = registry.register(&path) {
                    pending.push(token);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_pending_files,
            register_ifc_path,
            pick_ifc_file,
            save_exported_file
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar VisorGuBIMGal escritorio");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decoding_restores_spaces_and_utf8() {
        assert_eq!(decode_percent("mi%20modelo%20planta%201.ifc"), "mi modelo planta 1.ifc");
        assert_eq!(decode_percent("plano%C3%B1.dxf"), "planoñ.dxf");
    }

    #[test]
    fn collect_ifc_args_filters_flags_and_non_ifc_files() {
        let dir = std::env::temp_dir().join("gubim-t169-rust-test");
        let _ = fs::create_dir_all(&dir);
        let ifc = dir.join("Sample.IFC");
        let txt = dir.join("readme.txt");
        fs::write(&ifc, b"ISO-10303-21;").unwrap();
        fs::write(&txt, b"hello").unwrap();

        let args = vec![
            "app.exe".to_string(),
            "--flag".to_string(),
            txt.to_string_lossy().into_owned(),
            ifc.to_string_lossy().into_owned(),
        ];
        let found = collect_ifc_args(&args);
        assert_eq!(found, vec![ifc.clone()]);

        let registry = FileRegistry::default();
        let tok = registry.register(&ifc).expect("register valid ifc");
        assert_eq!(tok.name, "Sample.IFC");
        assert_eq!(tok.size, 13);
        assert!(registry.resolve(&tok.token).is_some());
        assert!(registry.resolve("unknown").is_none());

        let _ = fs::remove_dir_all(&dir);
    }
}
