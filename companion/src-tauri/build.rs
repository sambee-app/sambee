fn main() {
    println!("cargo:rerun-if-changed=../src/i18n");
    let directories: &[&str] = if std::env::var("PROFILE").as_deref() == Ok("debug") {
        &["../src/i18n/catalogs", "../src/i18n/drafts"]
    } else {
        &["../src/i18n/catalogs"]
    };
    let mut entries = Vec::new();
    for directory in directories {
        let catalog_dir = std::path::Path::new(directory);
        if !catalog_dir.is_dir() {
            continue;
        }
        for entry in catalog_dir.read_dir().expect("Read Companion localization catalog directory") {
            let path = entry.expect("Read Companion catalog entry").path();
            if path.extension().is_some_and(|ext| ext == "json") {
                let language = path.file_stem().and_then(|stem| stem.to_str()).expect("UTF-8 catalog name");
                let absolute_path = path.canonicalize().expect("Locate Companion catalog");
                entries.push(format!("({language:?}, include_str!({absolute_path:?})),"));
            }
        }
    }
    entries.sort();
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo output directory"));
    std::fs::write(out.join("catalogs.rs"), format!("&[{}]", entries.join("\n"))).expect("Write bundled Companion catalog index");
    tauri_build::build();
}
