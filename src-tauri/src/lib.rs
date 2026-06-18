mod fs_commands;
mod terminal;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(terminal::TerminalState::new())
        .invoke_handler(tauri::generate_handler![
            fs_commands::read_dir,
            fs_commands::read_file,
            fs_commands::write_file,
            terminal::term_create,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
