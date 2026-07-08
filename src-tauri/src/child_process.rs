//! Shared process configuration for app-owned background commands.
//!
//! The release binary uses the Windows GUI subsystem and therefore has no
//! parent console. Without `CREATE_NO_WINDOW`, every console child (`git`,
//! `dotnet`, `npm`, language servers, …) briefly creates its own visible
//! terminal window. Keep this helper restricted to background processes; the
//! integrated terminal intentionally uses a PTY and must remain interactive.

use std::process::Command;

/// Prevent an app-owned background process from creating a console window on
/// Windows. This is a no-op on other platforms.
pub(crate) fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}

/// Tokio exposes its underlying standard-library command, so both sync and
/// async launch paths share exactly the same Windows policy.
pub(crate) fn hide_tokio_console_window(command: &mut tokio::process::Command) {
    hide_console_window(command.as_std_mut());
}
