mod agents;
mod file_index;
mod fs_commands;
mod git;
mod lsp;
mod runner;
mod search;
mod session;
mod terminal;
mod walk;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(terminal::TerminalState::new())
        .manage(lsp::LspState::new())
        .manage(search::SearchState::new())
        .invoke_handler(tauri::generate_handler![
            agents::agents_load,
            agents::agents_save,
            agents::acp_prompt,
            fs_commands::read_dir,
            fs_commands::read_file,
            fs_commands::read_file_base64,
            fs_commands::write_file,
            fs_commands::create_file,
            fs_commands::create_folder,
            fs_commands::rename_path,
            fs_commands::delete_to_trash,
            fs_commands::copy_path,
            fs_commands::move_path,
            fs_commands::reveal_in_explorer,
            search::search_in_dir,
            search::cancel_search,
            search::build_search_index,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Kill every child process (PTY shells + LSP servers) and their reader
            // threads, then force-quit. `portable-pty` doesn't kill its child on
            // drop and the PTY reader is a blocking OS thread, so relying on `Drop`
            // alone leaves the process alive — the window disappears but the app
            // process hangs around. We tear down on the window's Destroyed event
            // (fires once the last window is gone) and then `exit(0)` ourselves so
            // a stuck WebView/runtime thread can never keep the process up.
            match event {
                tauri::RunEvent::WindowEvent {
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } => {
                    eprintln!("[exit] window destroyed — tearing down children");
                    app.state::<terminal::TerminalState>().shutdown_all();
                    app.state::<lsp::LspState>().shutdown_all();
                    eprintln!("[exit] teardown done — forcing process exit");
                    std::process::exit(0);
                }
                tauri::RunEvent::ExitRequested { .. } => {
                    eprintln!("[exit] ExitRequested — tearing down children");
                    app.state::<terminal::TerminalState>().shutdown_all();
                    app.state::<lsp::LspState>().shutdown_all();
                    eprintln!("[exit] teardown done — forcing process exit");
                    std::process::exit(0);
                }
                _ => {}
            }
        });
}
