// Garante que a pasta do cliente exista (o rust-embed exige) e recompila quando ela muda.
use std::path::Path;

fn main() {
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../client/dist");
    if !dist.exists() {
        std::fs::create_dir_all(&dist).expect("criar client/dist");
        std::fs::write(
            dist.join("index.html"),
            "<!doctype html><meta charset=utf-8><title>PadoSpeak</title>\
             <p style=\"font-family:sans-serif\">Cliente web ainda não compilado. Rode <code>npm run build</code> e recompile o servidor.</p>",
        )
        .expect("placeholder");
    }
    println!("cargo:rerun-if-changed=../client/dist");
}
