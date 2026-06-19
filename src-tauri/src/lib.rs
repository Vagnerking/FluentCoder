mod file_index;
mod fs_commands;
mod git;
mod lsp;
mod runner;
mod search;
mod session;
mod terminal;
mod walk;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(terminal::TerminalState::new())
        .manage(lsp::LspState::new())
        .invoke_handler(tauri::generate_handler![
            fs_commands::read_dir,
            fs_commands::read_file,
            fs_commands::read_file_base64,
            fs_commands::write_file,
            fs_commands::create_file,
            fs_commands::create_folder,
            search::search_in_dir,
            file_index::list_project_files,
            git::git_branch,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_commit,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_log,
            git::git_log_file,
            git::git_blame,
            runner::run_configs_load,
            runner::run_configs_save,
            runner::run_configs_detect,
            session::session_load,
            session::session_set_last_folder,
            terminal::term_create,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            lsp::lsp_start_server,
            lsp::lsp_stop_server,
            lsp::lsp_bridge_info,
            lsp::lsp_ensure_csharp_server,
            lsp::lsp_ensure_ts_server,
            lsp::razor::lsp_ensure_razor_server,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
