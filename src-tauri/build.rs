fn main() {
    let mut attributes = tauri_build::Attributes::new();
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if windows_msvc {
        // tauri-winres links its default manifest only into application bins.
        // The lib test executable also imports TaskDialogIndirect and needs
        // Common Controls v6 before the Rust test harness can even start.
        // Embed the same manifest through the linker for every crate target,
        // disabling the default copy to avoid duplicate manifest resources.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory is required"),
        )
        .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attributes).expect("Tauri build configuration failed");
}
