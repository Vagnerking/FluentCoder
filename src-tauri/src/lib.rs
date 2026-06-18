mod fs_commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            fs_commands::read_dir,
            fs_commands::read_file,
            fs_commands::write_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
