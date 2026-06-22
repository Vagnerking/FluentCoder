//! Windows 11 **Snap Layouts** for our frameless title bar — our own implementation.
//!
//! Why the obvious approach fails: subclassing the top-level window and answering
//! `HTMAXBUTTON` in `WM_NCHITTEST` never fires, because the WebView2 child window
//! covers the client area and swallows the mouse — the parent's hit-test is never
//! called over the title bar.
//!
//! The trick (overlay): create a tiny, transparent native `STATIC` child window
//! placed exactly over the maximize button, ABOVE the WebView2 child in z-order.
//! Being a real native window, the OS hit-tests it directly; its `WM_NCHITTEST`
//! returns `HTMAXBUTTON`, so Windows shows the Snap Layouts flyout. We forward the
//! click to maximize/restore and emit hover events (the overlay covers the button,
//! so the webview can't `:hover` it).

/// Front end reports its maximize button's rect (CSS px, viewport coords); we
/// create or move the overlay there. A zero-size rect removes the overlay.
#[tauri::command]
pub fn snap_set_max_button_rect(window: tauri::Window, x: f64, y: f64, width: f64, height: f64) {
    #[cfg(windows)]
    win::set_rect(window, x, y, width, height);
    #[cfg(not(windows))]
    {
        let _ = (window, x, y, width, height);
    }
}

#[cfg(windows)]
mod win {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use tauri::{Emitter, Manager, Window};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, IsWindow, IsZoomed, LoadCursorW, SendMessageW, SetCursor,
        SetWindowPos, HTMAXBUTTON, IDC_ARROW, SC_MAXIMIZE, SC_RESTORE, SWP_NOACTIVATE,
        WINDOW_EX_STYLE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP,
        WM_NCMOUSELEAVE, WM_SETCURSOR, WM_SYSCOMMAND, WS_CHILD, WS_VISIBLE,
    };

    const SUBCLASS_ID: usize = 0x534E_4150; // "SNAP"

    /// Parent (top-level) HWND → overlay child HWND, both as isize keys.
    static CHILDREN: OnceLock<Mutex<HashMap<isize, isize>>> = OnceLock::new();
    fn children() -> &'static Mutex<HashMap<isize, isize>> {
        CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Boxed and handed to the subclass as its ref-data, so it can emit hover
    /// events back to the right window and toggle maximize on the parent.
    struct State {
        parent: isize,
        hovering: bool,
        app: tauri::AppHandle,
        label: String,
    }

    impl State {
        fn emit(&self, hover: bool) {
            if let Some(win) = self.app.get_webview_window(&self.label) {
                let _ = win.emit("snap-max-hover", hover);
            }
        }
    }

    pub fn set_rect(window: Window, x: f64, y: f64, width: f64, height: f64) {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let parent = hwnd.0 as isize;
        let scale = window.scale_factor().unwrap_or(1.0);
        let px = (x * scale).round() as i32;
        let py = (y * scale).round() as i32;
        let pw = (width * scale).round() as i32;
        let ph = (height * scale).round() as i32;
        let app = window.app_handle().clone();
        let label = window.label().to_string();

        // CreateWindow / SetWindowPos / SetWindowSubclass MUST run on the UI thread
        // that owns the parent window.
        let _ = window.run_on_main_thread(move || unsafe {
            let parent_hwnd = HWND(parent as *mut _);
            if !IsWindow(Some(parent_hwnd)).as_bool() {
                return;
            }
            let existing = children().lock().ok().and_then(|m| m.get(&parent).copied());

            // Button gone (collapsed/hidden) → tear the overlay down.
            if pw <= 0 || ph <= 0 {
                if let Some(child) = existing {
                    let _ = DestroyWindow(HWND(child as *mut _));
                }
                return;
            }

            if let Some(child) = existing {
                let _ = SetWindowPos(
                    HWND(child as *mut _),
                    None,
                    px,
                    py,
                    pw,
                    ph,
                    SWP_NOACTIVATE,
                );
                return;
            }

            let Ok(child) = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                PCWSTR::null(),
                WS_CHILD | WS_VISIBLE,
                px,
                py,
                pw,
                ph,
                Some(parent_hwnd),
                None,
                None,
                None,
            ) else {
                return;
            };
            let state = Box::new(State { parent, hovering: false, app, label });
            let raw = Box::into_raw(state) as usize;
            let _ = SetWindowSubclass(child, Some(overlay_proc), SUBCLASS_ID, raw);
            if let Ok(mut m) = children().lock() {
                m.insert(parent, child.0 as isize);
            }
        });
    }

    unsafe extern "system" fn overlay_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        let st = data as *mut State;
        match msg {
            // The whole overlay IS the maximize button → snap flyout on hover.
            WM_NCHITTEST => {
                if !st.is_null() {
                    let s = &mut *st;
                    if !s.hovering {
                        s.hovering = true;
                        s.emit(true);
                        let mut t = TRACKMOUSEEVENT {
                            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                            dwFlags: TME_LEAVE | TME_NONCLIENT,
                            hwndTrack: hwnd,
                            dwHoverTime: 0,
                        };
                        let _ = TrackMouseEvent(&mut t);
                    }
                    return LRESULT(HTMAXBUTTON as isize);
                }
            }
            WM_NCMOUSELEAVE => {
                if !st.is_null() {
                    let s = &mut *st;
                    if s.hovering {
                        s.hovering = false;
                        s.emit(false);
                    }
                }
            }
            // Swallow the press; toggle maximize on release (the flyout is OS-driven).
            WM_NCLBUTTONDOWN if wparam.0 as u32 == HTMAXBUTTON => return LRESULT(0),
            WM_NCLBUTTONUP if wparam.0 as u32 == HTMAXBUTTON => {
                if !st.is_null() {
                    let parent = HWND((*st).parent as *mut _);
                    let cmd = if IsZoomed(parent).as_bool() { SC_RESTORE } else { SC_MAXIMIZE };
                    SendMessageW(parent, WM_SYSCOMMAND, Some(WPARAM(cmd as usize)), Some(LPARAM(0)));
                }
                return LRESULT(0);
            }
            WM_SETCURSOR if !st.is_null() => {
                if let Ok(cursor) = LoadCursorW(None, IDC_ARROW) {
                    SetCursor(Some(cursor));
                }
                return LRESULT(1);
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(overlay_proc), id);
                if !st.is_null() {
                    let owned = Box::from_raw(st);
                    if let Ok(mut m) = children().lock() {
                        m.remove(&owned.parent);
                    }
                }
                return DefSubclassProc(hwnd, msg, wparam, lparam);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}
