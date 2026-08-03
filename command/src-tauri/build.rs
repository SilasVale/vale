fn main() {
    // Fix ProcessPrng: target Windows 10+ APIs
    if std::env::var("TARGET").unwrap_or_default().contains("windows") {
        println!("cargo:rustc-link-lib=bcrypt");
    }
    tauri_build::build()
}
