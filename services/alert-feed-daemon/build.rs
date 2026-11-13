use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR")?);
    let proto_dir = manifest_dir.join("../../proto");
    let proto_file = proto_dir.join("gtfs-realtime.proto");

    println!("cargo:rerun-if-changed={}", proto_file.display());

    let output = PathBuf::from(std::env::var("OUT_DIR")?);
    prost_build::Config::new()
        .file_descriptor_set_path(output.join("gtfs-descriptor.bin"))
        .compile_protos(&[&proto_file], &[&proto_dir])?;

    Ok(())
}
