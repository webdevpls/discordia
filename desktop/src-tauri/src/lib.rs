use std::path::PathBuf;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};

/// Sugerido na primeira abertura; cada pessoa pode usar o próprio servidor.
const DEFAULT_SERVER: &str = "https://discordia.visionstds.com.br";

/// Servidor em uso. Câmera, microfone e tela só são liberados para ele.
struct Server(Mutex<Option<Url>>);

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("server.txt"))
}

/// Aceita "meuservidor.com" ou a URL completa. HTTP só para a própria máquina,
/// porque o navegador bloqueia câmera e microfone em páginas sem HTTPS.
fn parse_server(input: &str) -> Result<Url, String> {
    let input = input.trim().trim_end_matches('/');
    let full = if input.contains("://") { input.to_string() } else { format!("https://{input}") };
    let url = Url::parse(&full).map_err(|_| "Endereço inválido.".to_string())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => Ok(url),
        "http" if local => Ok(url),
        "http" => Err("Use https://: sem HTTPS o navegador bloqueia câmera e microfone.".into()),
        _ => Err("Endereço inválido.".into()),
    }
}

fn saved_server(app: &AppHandle) -> Option<Url> {
    if let Ok(env) = std::env::var("DISCORDIA_URL") {
        return parse_server(&env).ok();
    }
    let text = std::fs::read_to_string(config_file(app)?).ok()?;
    parse_server(&text).ok()
}

/// Página local de escolha do servidor (embutida no app).
fn setup_url() -> Url {
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(base).expect("url fixa")
}

#[tauri::command]
fn current_server(app: AppHandle) -> String {
    saved_server(&app).map(|u| u.to_string()).unwrap_or_else(|| DEFAULT_SERVER.to_string())
}

#[tauri::command]
fn connect(app: AppHandle, server: State<Server>, url: String) -> Result<(), String> {
    let url = parse_server(&url)?;
    if let Some(file) = config_file(&app) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&file, url.as_str()).map_err(|e| format!("Não consegui salvar: {e}"))?;
    }
    *server.0.lock().unwrap() = Some(url.clone());
    let window = app.get_webview_window("main").ok_or("Janela não encontrada.")?;
    window.navigate(url).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Server(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![current_server, connect])
        .menu(|app| {
            let menu = Menu::default(app)?;
            // No macOS o primeiro submenu é o do app ("Discordia").
            if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
                let item = MenuItem::with_id(app, "server", "Trocar servidor…", true, None::<&str>)?;
                app_menu.insert(&item, 1)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == "server" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.navigate(setup_url());
                }
            }
        })
        .setup(|app| {
            let saved = saved_server(app.handle());
            *app.state::<Server>().0.lock().unwrap() = saved.clone();
            let start = match saved {
                Some(url) => WebviewUrl::External(url),
                None => WebviewUrl::App("index.html".into()),
            };
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", start)
                .title("Discordia")
                .inner_size(1280.0, 800.0)
                .min_inner_size(420.0, 520.0)
                .on_permission_request(move |webview, kind| {
                    let trusted = handle.state::<Server>().0.lock().unwrap().as_ref().map(|s| s.origin());
                    let here = webview.url().ok().map(|u| u.origin());
                    match kind {
                        PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::DisplayCapture
                            if trusted.is_some() && trusted == here =>
                        {
                            PermissionResponse::Allow
                        }
                        _ => PermissionResponse::Default,
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Discordia");
}
