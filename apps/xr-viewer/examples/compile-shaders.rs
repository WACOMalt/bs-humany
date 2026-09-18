//! Compile the GLSL in `shaders/` to the SPIR-V committed beside it.
//!
//!   SHADERC_LIB_DIR=/usr/lib64 cargo run --example compile-shaders
//!
//! An example rather than a binary, and `shaderc` a dev-dependency, so that an ordinary
//! `cargo build --release` needs no shader toolchain at all: the `.spv` files are committed and
//! the viewer embeds them. That is the same bargain the rest of this repository makes with
//! generated data -- a generator, its output in the tree, and a check that the two agree.

use std::path::Path;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("shaders");
    let compiler = shaderc::Compiler::new().expect("shaderc");
    let mut options = shaderc::CompileOptions::new().expect("shaderc options");
    options.set_target_env(
        shaderc::TargetEnv::Vulkan,
        shaderc::EnvVersion::Vulkan1_1 as u32,
    );
    options.set_optimization_level(shaderc::OptimizationLevel::Performance);

    for (name, kind) in [
        ("skeleton.vert", shaderc::ShaderKind::Vertex),
        ("skeleton.frag", shaderc::ShaderKind::Fragment),
        ("panel.vert", shaderc::ShaderKind::Vertex),
        ("panel.frag", shaderc::ShaderKind::Fragment),
    ] {
        let source = std::fs::read_to_string(dir.join(name)).expect("reading the shader");
        let built = compiler
            .compile_into_spirv(&source, kind, name, "main", Some(&options))
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let out = dir.join(format!("{name}.spv"));
        std::fs::write(&out, built.as_binary_u8()).expect("writing the spv");
        println!("{} -> {} ({} bytes)", name, out.display(), built.as_binary_u8().len());
    }
}
