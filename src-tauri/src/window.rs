//! New-window support.
//!
//! New workbenches are same-process `WebviewWindow`s: the native runtime and
//! frontend assets stay warm, while per-window runtime ids isolate services.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Manager, PhysicalPosition, PhysicalSize, State};

const MIN_WINDOW_WIDTH: u32 = 600;
const MIN_WINDOW_HEIGHT: u32 = 400;
const CASCADE_OFFSET: i32 = 24;
static WORKBENCH_WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct WindowPlacement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    maximized: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    monitor_name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct MonitorRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Default)]
pub struct WindowPlacementState {
    normal: Mutex<Option<WindowPlacement>>,
}

impl WindowPlacementState {
    pub fn new() -> Self {
        Self::default()
    }
}

fn placement_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Sem diretório de dados do app: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("window-state.json"))
}

fn read_placement(app: &tauri::AppHandle) -> Option<WindowPlacement> {
    let raw = std::fs::read_to_string(placement_file(app).ok()?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_placement(app: &tauri::AppHandle, value: &WindowPlacement) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(placement_file(app)?, json)
        .map_err(|e| format!("Falha ao salvar a posição da janela: {e}"))
}

fn monitor_rect(monitor: &tauri::Monitor) -> MonitorRect {
    MonitorRect {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    }
}

fn clamp_to_monitor(mut value: WindowPlacement, monitor: MonitorRect) -> WindowPlacement {
    value.width = value.width.max(MIN_WINDOW_WIDTH).min(monitor.width);
    value.height = value.height.max(MIN_WINDOW_HEIGHT).min(monitor.height);
    let max_x = monitor
        .x
        .saturating_add(monitor.width.saturating_sub(value.width) as i32);
    let max_y = monitor
        .y
        .saturating_add(monitor.height.saturating_sub(value.height) as i32);
    value.x = value.x.clamp(monitor.x, max_x);
    value.y = value.y.clamp(monitor.y, max_y);
    value
}

fn parse_launch_placement<I>(args: I) -> Option<WindowPlacement>
where
    I: IntoIterator<Item = String>,
{
    let mut x = None;
    let mut y = None;
    let mut width = None;
    let mut height = None;
    let mut monitor_name = None;
    let mut maximized = false;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--window-x" => x = args.next()?.parse().ok(),
            "--window-y" => y = args.next()?.parse().ok(),
            "--window-width" => width = args.next()?.parse().ok(),
            "--window-height" => height = args.next()?.parse().ok(),
            "--window-monitor" => monitor_name = args.next().filter(|name| !name.is_empty()),
            "--window-maximized" => maximized = true,
            _ => {}
        }
    }
    Some(WindowPlacement {
        x: x?,
        y: y?,
        width: width?,
        height: height?,
        maximized,
        monitor_name,
    })
}

fn target_monitor<'a>(
    placement: &WindowPlacement,
    monitors: &'a [tauri::Monitor],
) -> Option<&'a tauri::Monitor> {
    if let Some(name) = placement.monitor_name.as_ref() {
        if let Some(found) = monitors.iter().find(|m| m.name() == Some(name)) {
            return Some(found);
        }
    }
    monitors.iter().find(|monitor| {
        let rect = monitor_rect(monitor);
        placement.x >= rect.x
            && placement.y >= rect.y
            && placement.x < rect.x.saturating_add(rect.width as i32)
            && placement.y < rect.y.saturating_add(rect.height as i32)
    })
}

fn capture_normal_placement(window: &tauri::WebviewWindow) -> Option<WindowPlacement> {
    if window.is_maximized().ok()? {
        return None;
    }
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let monitor_name = window
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|monitor| monitor.name().cloned());
    Some(WindowPlacement {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized: false,
        monitor_name,
    })
}

/// Applies either the parent-window placement passed to a fresh process or the
/// last persisted placement. A missing monitor falls back to the primary one.
pub fn restore_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let launch = parse_launch_placement(std::env::args());
    let Some(mut placement) = launch.or_else(|| read_placement(app)) else {
        if let Some(placement) = capture_normal_placement(&window) {
            if let Ok(mut state) = app.state::<WindowPlacementState>().normal.lock() {
                *state = Some(placement);
            }
        }
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let Some(monitor) = target_monitor(&placement, &monitors)
        .cloned()
        .or_else(|| window.primary_monitor().ok().flatten())
    else {
        return;
    };
    placement = clamp_to_monitor(placement, monitor_rect(&monitor));
    placement.monitor_name = monitor.name().cloned();
    let _ = window.set_size(PhysicalSize::new(placement.width, placement.height));
    let _ = window.set_position(PhysicalPosition::new(placement.x, placement.y));
    if placement.maximized {
        let _ = window.maximize();
    }
    if let Ok(mut state) = app.state::<WindowPlacementState>().normal.lock() {
        let mut normal = placement;
        normal.maximized = false;
        *state = Some(normal);
    }
}

/// Tracks the last non-maximized bounds and flushes them when the main window
/// closes. Detached editor windows deliberately keep their own drag placement.
pub fn record_main_window_event(app: &tauri::AppHandle, label: &str, event: &tauri::WindowEvent) {
    if label != "main" && !label.starts_with("workbench-") {
        return;
    }
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            if let Some(placement) = capture_normal_placement(&window) {
                if let Ok(mut state) = app.state::<WindowPlacementState>().normal.lock() {
                    *state = Some(placement);
                }
            }
        }
        tauri::WindowEvent::CloseRequested { .. } => persist_window(app, label),
        _ => {}
    }
}

pub fn persist_main_window(app: &tauri::AppHandle) {
    persist_window(app, "main");
}

fn persist_window(app: &tauri::AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let placement = app
        .state::<WindowPlacementState>()
        .normal
        .lock()
        .ok()
        .and_then(|value| value.clone());
    if let Some(mut placement) = placement {
        placement.maximized = maximized;
        let _ = write_placement(app, &placement);
    }
}

/// Reveals a window only after its webview has painted the application shell.
/// Configured windows start hidden so Windows never flashes their default
/// position or an unpainted white surface before placement restoration.
#[tauri::command]
pub fn window_ready(window: tauri::Window) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

/// Opens a fresh workbench inside the already-warm process. Its geometry is set
/// while hidden, so creation is immediate and never flashes on another monitor.
#[tauri::command]
pub async fn open_new_window(
    app: tauri::AppHandle,
    window: tauri::Window,
    remote_attach: Option<String>,
) -> Result<(), String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let maximized = window.is_maximized().unwrap_or(false);
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "não foi possível identificar o monitor atual".to_string())?;
    let mut placement = WindowPlacement {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized,
        monitor_name: monitor.name().cloned(),
    };
    if !maximized {
        placement.x = placement.x.saturating_add(CASCADE_OFFSET);
        placement.y = placement.y.saturating_add(CASCADE_OFFSET);
    }
    placement = clamp_to_monitor(placement, monitor_rect(&monitor));

    let scale = monitor.scale_factor();
    let label = format!(
        "workbench-{}",
        WORKBENCH_WINDOW_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let effects = tauri::window::EffectsBuilder::new()
        .effect(tauri::window::Effect::Mica)
        .build();
    let url = match remote_attach {
        Some(payload) => format!("index.html?freshWindow=1&remoteAttach={payload}"),
        None => "index.html?freshWindow=1".to_string(),
    };
    let new_window =
        tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(url.into()))
            .title("Fluent Coder")
            .position(placement.x as f64 / scale, placement.y as f64 / scale)
            .inner_size(
                placement.width as f64 / scale,
                placement.height as f64 / scale,
            )
            .min_inner_size(MIN_WINDOW_WIDTH as f64, MIN_WINDOW_HEIGHT as f64)
            .maximized(placement.maximized)
            .resizable(true)
            .decorations(false)
            .transparent(true)
            .effects(effects)
            .visible(false)
            .build()
            .map_err(|e| format!("não foi possível abrir uma nova janela: {e}"))?;
    if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png")) {
        let _ = new_window.set_icon(icon);
    }
    Ok(())
}

/// True when this instance was launched as a fresh window (`--new`), so the UI
/// starts empty instead of reopening the last folder.
#[tauri::command]
pub fn is_fresh_window() -> bool {
    std::env::args().any(|arg| arg == "--new")
}

// ---- "Move editor to new window" handoff (tear-off tab) ----
//
// A detached editor is a same-process `WebviewWindow` (so it can hand the file
// back via events). The file payload is passed through this in-memory stash by a
// one-time token instead of the URL, so large/dirty buffers transfer safely.

/// Hit-test for tab tear-off: returns the label of the app window under the
/// screen point (`x`, `y` in logical/CSS pixels), excluding `exclude` (the drag
/// source). `None` → the point is over empty desktop / another app, so the
/// caller spawns a fresh detached window there instead of moving the tab.
#[tauri::command]
pub fn window_at_position(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    exclude: String,
) -> Option<String> {
    for (label, win) in app.webview_windows() {
        if label == exclude {
            continue;
        }
        let scale = win.scale_factor().unwrap_or(1.0);
        let pos = match win.outer_position() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let size = match win.outer_size() {
            Ok(s) => s,
            Err(_) => continue,
        };
        // Tauri reports physical pixels relative to the virtual desktop; the web
        // `screenX/Y` are logical. Normalise both to logical to compare.
        let lx = pos.x as f64 / scale;
        let ly = pos.y as f64 / scale;
        let lw = size.width as f64 / scale;
        let lh = size.height as f64 / scale;
        if x >= lx && x <= lx + lw && y >= ly && y <= ly + lh {
            return Some(label);
        }
    }
    None
}

/// The global cursor position in LOGICAL/CSS pixels (relative to the virtual
/// desktop). HTML5 `drag` events freeze once the cursor leaves the source
/// window, so the dragging window polls this to keep tracking the cursor over
/// other windows / the desktop. Falls back to the window's own scale factor.
#[tauri::command]
pub fn cursor_position(window: tauri::Window) -> Result<(f64, f64), String> {
    let pos = window.cursor_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    Ok((pos.x / scale, pos.y / scale))
}

#[derive(Default)]
pub struct WindowHandoffState {
    payloads: Mutex<HashMap<String, String>>,
    next: AtomicU64,
}

impl WindowHandoffState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Stashes a JSON payload (the file to detach/redock), returning its token.
#[tauri::command]
pub fn editor_stash(
    payload: String,
    state: State<'_, WindowHandoffState>,
) -> Result<String, String> {
    let token = format!("ed{}", state.next.fetch_add(1, Ordering::Relaxed));
    state
        .payloads
        .lock()
        .map_err(|e| e.to_string())?
        .insert(token.clone(), payload);
    Ok(token)
}

/// Reads a stashed payload WITHOUT removing it, so the detached window survives a
/// reload (and StrictMode's double-mount in dev). Null if unknown/released.
#[tauri::command]
pub fn editor_take(token: String, state: State<'_, WindowHandoffState>) -> Option<String> {
    state.payloads.lock().ok()?.get(&token).cloned()
}

/// Overwrites a stashed payload (the detached window persists its edits here, so a
/// reload restores the latest content instead of the original).
#[tauri::command]
pub fn editor_update(
    token: String,
    payload: String,
    state: State<'_, WindowHandoffState>,
) -> Result<(), String> {
    if let Ok(mut map) = state.payloads.lock() {
        if let Some(slot) = map.get_mut(&token) {
            *slot = payload;
        }
    }
    Ok(())
}

/// Releases a stashed payload (on re-dock or window close) so it doesn't leak.
#[tauri::command]
pub fn editor_release(token: String, state: State<'_, WindowHandoffState>) {
    if let Ok(mut map) = state.payloads.lock() {
        map.remove(&token);
    }
}

// ---- Active editor group (which window receives newly-opened files) ----
//
// VS Code-style "open goes to the focused editor group". Each window reports its
// focus; the main window queries this before opening a file and, when a detached
// window is active, routes the file there instead of opening it locally.

#[derive(Clone, serde::Serialize)]
pub struct ActiveEditor {
    pub label: String,
    pub token: String,
}

#[derive(Default)]
pub struct ActiveEditorState {
    active: Mutex<Option<ActiveEditor>>,
}

impl ActiveEditorState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// A detached window became active (focused) — new opens should go to it.
#[tauri::command]
pub fn set_active_editor(label: String, token: String, state: State<'_, ActiveEditorState>) {
    if let Ok(mut active) = state.active.lock() {
        *active = Some(ActiveEditor { label, token });
    }
}

/// The main window became active — new opens go to it (the home group).
#[tauri::command]
pub fn clear_active_editor(state: State<'_, ActiveEditorState>) {
    if let Ok(mut active) = state.active.lock() {
        *active = None;
    }
}

/// The active detached editor group, or null when the main window is active.
#[tauri::command]
pub fn get_active_editor(state: State<'_, ActiveEditorState>) -> Option<ActiveEditor> {
    state.active.lock().ok()?.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_keeps_window_inside_negative_coordinate_monitor() {
        let placement = WindowPlacement {
            x: -3000,
            y: -200,
            width: 1600,
            height: 1000,
            maximized: false,
            monitor_name: Some("DISPLAY2".into()),
        };
        let monitor = MonitorRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };

        let clamped = clamp_to_monitor(placement, monitor);

        assert_eq!(clamped.x, -1920);
        assert_eq!(clamped.y, 0);
        assert_eq!(clamped.width, 1600);
        assert_eq!(clamped.height, 1000);
    }

    #[test]
    fn clamp_shrinks_oversized_window_to_available_monitor() {
        let placement = WindowPlacement {
            x: 100,
            y: 100,
            width: 3000,
            height: 2000,
            maximized: false,
            monitor_name: None,
        };
        let monitor = MonitorRect {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
        };

        let clamped = clamp_to_monitor(placement, monitor);

        assert_eq!((clamped.x, clamped.y), (0, 0));
        assert_eq!((clamped.width, clamped.height), (1280, 720));
    }

    #[test]
    fn parses_legacy_geometry_passed_to_fresh_process() {
        let args = [
            "fluent-coder",
            "--new",
            "--window-x",
            "1920",
            "--window-y",
            "40",
            "--window-width",
            "1200",
            "--window-height",
            "800",
            "--window-monitor",
            "DISPLAY 2",
            "--window-maximized",
        ]
        .into_iter()
        .map(str::to_string);

        let parsed = parse_launch_placement(args).unwrap();

        assert_eq!(parsed.x, 1920);
        assert_eq!(parsed.y, 40);
        assert_eq!(parsed.width, 1200);
        assert_eq!(parsed.height, 800);
        assert_eq!(parsed.monitor_name.as_deref(), Some("DISPLAY 2"));
        assert!(parsed.maximized);
    }
}
