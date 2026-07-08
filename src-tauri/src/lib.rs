mod agents;
mod child_process;
mod dap;
mod file_index;
mod fs_commands;
mod git;
mod graph;
mod lsp;
mod mcp;
mod package_intel;
mod razor;
mod runner;
mod search;
mod session;
mod snap;
mod ssh;
mod terminal;
mod testrunner;
mod text_io;
mod walk;
mod window;
mod workspace_open;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `fluent-coder --mcp <root>` runs the knowledge MCP server (stdio) instead of
    // the GUI, so Claude Code / other MCP clients can query the project's brain.
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--mcp") {
        let root = args
            .get(pos + 1)
            .cloned()
            .unwrap_or_else(|| ".".to_string());
        mcp::run_mcp_server(root);
        return;
    }

    let initial_workspace_files = workspace_open::workspace_files_from_args(&args);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Explicitly stamp every window with a crisp, high-resolution icon so
            // the Windows taskbar / Alt-Tab show the app logo (a frameless,
            // transparent window won't always pick up the embedded default).
            #[cfg(desktop)]
            {
                let icon =
                    tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png")).ok();
                if let Some(icon) = icon {
                    for (_, win) in app.webview_windows() {
                        let _ = win.set_icon(icon.clone());
                    }
                }
            }
            window::restore_main_window(app.handle());
            // Point the Razor/C# pipeline diagnostic log at the app data dir so a
            // failing projection run leaves an inspectable trace (razor-diag.log).
            if let Ok(dir) = app.path().app_data_dir() {
                razor::diag::init(dir);
            }
            Ok(())
        })
        .manage(terminal::TerminalState::new())
        .manage(lsp::LspState::new())
        .manage(dap::DapState::new())
        .manage(search::SearchState::new())
        .manage(agents::AcpState::new())
        .manage(razor::commands::RazorState::new())
        .manage(ssh::SshState::new())
        .manage(window::WindowPlacementState::new())
        .manage(window::WindowHandoffState::new())
        .manage(window::ActiveEditorState::new())
        .manage(workspace_open::WorkspaceOpenState::new(
            initial_workspace_files,
        ))
        .invoke_handler(tauri::generate_handler![
            agents::agents_load,
            agents::agents_save,
            agents::acp_prompt,
            agents::acp_warm,
            agents::acp_cancel,
            agents::acp_stop_workspace,
            fs_commands::read_dir,
            fs_commands::read_file,
            fs_commands::read_file_with_encoding,
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
            file_index::has_dotnet_project,
            graph::build_context_graph,
            graph::build_knowledge_index,
            graph::build_context_bundle,
            graph::build_graph_agent_digest,
            package_intel::package_intel_audit,
            package_intel::package_intel_outdated,
            package_intel::package_intel_scan,
            package_intel::package_intel_versions,
            mcp::mcp_config,
            mcp::mcp_write_project_config,
            snap::snap_set_max_button_rect,
            git::git_branch,
            git::git_branches,
            git::git_remote_branches,
            git::git_remotes,
            git::git_remote_add,
            git::git_remote_remove,
            git::git_remote_rename,
            git::git_remote_set_url,
            git::git_checkout,
            git::git_create_branch,
            git::git_rename_branch,
            git::git_delete_branch,
            git::git_delete_remote_branch,
            git::git_checkout_remote_branch,
            git::git_status,
            git::git_worktrees,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_worktree_prune,
            git::git_stage,
            git::git_unstage,
            git::git_unstage_all,
            git::git_stage_all,
            git::git_commit,
            git::git_fetch,
            git::git_fetch_remote,
            git::git_pull,
            git::git_push,
            git::git_publish,
            git::git_log,
            git::git_graph,
            git::git_compare_upstream,
            git::git_log_file,
            git::git_log_line,
            git::git_show_file_at_commit,
            git::git_show_file_staged,
            git::git_diff_file_revision,
            git::git_diff_file,
            git::git_diff_file_staged,
            git::git_commit_files,
            git::git_blame,
            git::git_discard_file,
            git::git_discard_all,
            git::git_stash_push,
            git::git_stash_list,
            git::git_stash_files,
            git::git_stash_apply,
            git::git_stash_pop,
            git::git_stash_drop,
            git::git_revert_commit,
            git::git_undo_last_commit,
            git::git_snapshot_create,
            git::git_snapshot_restore,
            runner::run_configs_load,
            runner::run_configs_save,
            runner::run_configs_detect,
            session::session_load,
            session::session_set_last_folder,
            session::session_set_open_files,
            session::session_set_workspace,
            window::open_new_window,
            window::is_fresh_window,
            window::window_ready,
            window::window_at_position,
            window::cursor_position,
            window::editor_stash,
            window::editor_take,
            window::editor_update,
            window::editor_release,
            window::set_active_editor,
            window::clear_active_editor,
            window::get_active_editor,
            workspace_open::opened_workspace_files,
            terminal::term_create,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            lsp::lsp_start_server,
            lsp::lsp_stop_server,
            lsp::lsp_bridge_info,
            lsp::lsp_ensure_csharp_server,
            lsp::build::csharp_build_diagnostics,
            lsp::lsp_ensure_ts_server,
            lsp::lsp_ts_versions,
            lsp::lsp_ensure_npm_server,
            lsp::lsp_ensure_system_server,
            lsp::lsp_ensure_razor_server,
            dap::dap_ensure_netcoredbg,
            dap::dap_start_session,
            dap::dap_stop_session,
            dap::dap_list_dotnet_processes,
            dap::dap_resolve_dotnet_target,
            testrunner::dotnet_test_list,
            testrunner::dotnet_test_run,
            razor::commands::razor_prepare,
            razor::commands::razor_emit_live,
            razor::commands::razor_commit_live_map,
            razor::commands::razor_warm,
            razor::commands::razor_ensure_sidecar,
            razor::commands::razor_remap_to_generated,
            razor::commands::razor_remap_to_source,
            razor::commands::razor_remap_ranges_to_source,
            razor::commands::razor_remap_ranges_to_source_strict,
            razor::commands::razor_forget,
            razor::commands::razor_diag_log,
            ssh::ssh_connect,
            ssh::ssh_list_dir,
            ssh::ssh_read_file,
            ssh::ssh_read_file_base64,
            ssh::ssh_disconnect,
            ssh::ssh_write_file,
            ssh::ssh_create_file,
            ssh::ssh_create_folder,
            ssh::ssh_rename,
            ssh::ssh_move,
            ssh::ssh_delete,
            ssh::ssh_copy,
            ssh::ssh_term_create,
            ssh::ssh_term_write,
            ssh::ssh_term_resize,
            ssh::ssh_term_close,
            ssh::ssh_list_saved_hosts,
            ssh::ssh_search,
            ssh::ssh_canonicalize,
            ssh::ssh_build_context_graph,
            ssh::ssh_build_knowledge_index,
            ssh::ssh_build_context_bundle,
            ssh::ssh_build_graph_agent_digest,
            ssh::ssh_list_project_files,
            ssh::ssh_package_intel_audit,
            ssh::ssh_package_intel_outdated,
            ssh::ssh_package_intel_versions,
            ssh::ssh_run_configs_detect,
            ssh::ssh_run_configs_load,
            ssh::ssh_run_configs_save,
            ssh::ssh_agents_load,
            ssh::ssh_agents_save,
            ssh::ssh_git_status,
            ssh::ssh_git_worktrees,
            ssh::ssh_git_worktree_add,
            ssh::ssh_git_worktree_remove,
            ssh::ssh_git_worktree_prune,
            ssh::ssh_git_branch,
            ssh::ssh_git_branches,
            ssh::ssh_git_remote_branches,
            ssh::ssh_git_remotes,
            ssh::ssh_git_remote_add,
            ssh::ssh_git_remote_remove,
            ssh::ssh_git_remote_rename,
            ssh::ssh_git_remote_set_url,
            ssh::ssh_git_checkout,
            ssh::ssh_git_create_branch,
            ssh::ssh_git_rename_branch,
            ssh::ssh_git_delete_branch,
            ssh::ssh_git_delete_remote_branch,
            ssh::ssh_git_checkout_remote_branch,
            ssh::ssh_git_stage,
            ssh::ssh_git_unstage,
            ssh::ssh_git_unstage_all,
            ssh::ssh_git_stage_all,
            ssh::ssh_git_commit,
            ssh::ssh_git_fetch,
            ssh::ssh_git_fetch_remote,
            ssh::ssh_git_pull,
            ssh::ssh_git_push,
            ssh::ssh_git_log,
            ssh::ssh_git_graph,
            ssh::ssh_git_compare_upstream,
            ssh::ssh_git_log_file,
            ssh::ssh_git_show_file_at_commit,
            ssh::ssh_git_show_file_staged,
            ssh::ssh_git_diff_file_revision,
            ssh::ssh_git_diff_file,
            ssh::ssh_git_diff_file_staged,
            ssh::ssh_git_commit_files,
            ssh::ssh_git_blame,
            ssh::ssh_git_stash_list,
            ssh::ssh_git_stash_files,
            ssh::ssh_git_stash_push,
            ssh::ssh_git_stash_apply,
            ssh::ssh_git_stash_pop,
            ssh::ssh_git_stash_drop,
            ssh::ssh_git_revert_commit,
            ssh::ssh_git_undo_last_commit,
            ssh::ssh_git_discard_file,
            ssh::ssh_git_discard_all,
            ssh::ssh_lsp_start,
            ssh::ssh_lsp_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::WindowEvent { label, event, .. } = &event {
                window::record_main_window_event(app, label, event);
            }
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
                    // With multiple windows (remote SSH windows, issue #8), only
                    // tear down + exit when the LAST window closes; otherwise the
                    // remaining windows must keep running.
                    if !app.webview_windows().is_empty() {
                        return;
                    }
                    eprintln!("[exit] last window destroyed — tearing down children");
                    app.state::<terminal::TerminalState>().shutdown_all();
                    app.state::<agents::AcpState>().shutdown_all();
                    app.state::<lsp::LspState>().shutdown_all();
                    app.state::<dap::DapState>().shutdown_all();
                    app.state::<razor::commands::RazorState>()
                        .shutdown_sidecar();
                    app.state::<ssh::SshState>().shutdown_all();
                    eprintln!("[exit] teardown done — forcing process exit");
                    std::process::exit(0);
                }
                tauri::RunEvent::ExitRequested { .. } => {
                    window::persist_main_window(app);
                    eprintln!("[exit] ExitRequested — tearing down children");
                    app.state::<terminal::TerminalState>().shutdown_all();
                    app.state::<agents::AcpState>().shutdown_all();
                    app.state::<lsp::LspState>().shutdown_all();
                    app.state::<dap::DapState>().shutdown_all();
                    app.state::<razor::commands::RazorState>()
                        .shutdown_sidecar();
                    app.state::<ssh::SshState>().shutdown_all();
                    eprintln!("[exit] teardown done — forcing process exit");
                    std::process::exit(0);
                }
                _ => {}
            }
        });
}
