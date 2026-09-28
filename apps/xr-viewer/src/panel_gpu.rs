//! What draws the egui panels on the GPU: a pipeline of their own over the renderer's render
//! pass, a sampler and descriptor set layout for egui's textures, a texture a texture id (with a
//! mip chain where the device can build one), and a vertex and an index buffer per swapchain
//! image that each frame's meshes are packed into.
//!
//! The renderer owns one of these, and applies egui's texture changes and records the panels'
//! draws through it; what is here is only what those need.

use anyhow::Result;
use ash::vk;
use std::ffi::CStr;

use crate::gpu::{Buffer, allocate, shader_module};

/// How many egui vertices and indices a frame of the panel may have; more is cut off.
pub(crate) const PANEL_VERTICES: usize = 32768;
pub(crate) const PANEL_INDICES: usize = 98304;
/// Where a panel mesh's clip rectangle sits in the push constants: after the 64-byte matrix,
/// which is the `layout(offset = 64)` in `panel.frag`.
pub(crate) const PANEL_CLIP_OFFSET: u32 = 64;

/// What draws the panel: its own pipeline over the same render pass, a sampler and a set layout
/// for egui's textures, a texture per egui texture id, and per-image vertex and index buffers.
pub(crate) struct PanelGpu {
    pub(crate) pipeline: vk::Pipeline,
    pub(crate) layout: vk::PipelineLayout,
    set_layout: vk::DescriptorSetLayout,
    pool: vk::DescriptorPool,
    sampler: vk::Sampler,
    /// Whether this device can build egui's textures a mip chain: blit from and to the format and
    /// filter it linearly. Asked once at start-up; without it every texture is one level, as before.
    mipmapped: bool,
    pub(crate) textures: std::collections::HashMap<u64, Texture>,
    pub(crate) per_target: Vec<(Buffer, Buffer)>,
}

/// One egui texture on the GPU, with the CPU copy that partial updates are patched into.
pub(crate) struct Texture {
    pub(crate) image: vk::Image,
    memory: vk::DeviceMemory,
    view: vk::ImageView,
    pub(crate) set: vk::DescriptorSet,
    pub(crate) size: [usize; 2],
    /// Levels in the image's mip chain, level 0 the pixels egui gave.
    pub(crate) levels: u32,
    pub(crate) pixels: Vec<u8>,
}

/// The format of every egui texture: egui's colours are sRGB, and the sampler decodes them to
/// linear before it filters, as a blit between levels does.
pub(crate) const PANEL_TEXTURE_FORMAT: vk::Format = vk::Format::R8G8B8A8_SRGB;

/// How many levels a panel texture of `size` gets: the whole chain down to one texel, or just the
/// one when the device cannot blit and filter the format.
///
/// The panel is drawn at two pixels a point, and read from across a room: a properties panel at
/// arm's length or further covers fewer of the headset's pixels than its texture has, so text is
/// minified. A single level sampled bilinearly then skips texels -- the thin strokes of a glyph
/// are there in one frame and gone in the next as the head moves, the shimmer on the World tab's
/// long notes. A mip chain sampled trilinearly averages them instead. Solid fills are untouched:
/// egui paints them from one white texel with the same coordinate at every vertex, so the
/// sampler sees no change across them and stays at level 0.
fn mip_levels(size: [usize; 2], mipmapped: bool) -> u32 {
    let largest = size[0].max(size[1]).max(1);
    if mipmapped {
        usize::BITS - largest.leading_zeros()
    } else {
        1
    }
}

/// Whether a format's optimal-tiling features let a mip chain be built on the GPU and sampled
/// trilinearly: blits from and to it, and linear filtering, which both the blit and the sampler use.
pub(crate) fn can_mipmap(features: vk::FormatFeatureFlags) -> bool {
    features.contains(
        vk::FormatFeatureFlags::BLIT_SRC
            | vk::FormatFeatureFlags::BLIT_DST
            | vk::FormatFeatureFlags::SAMPLED_IMAGE_FILTER_LINEAR,
    )
}

/// egui's texture ids as one number, for the texture map.
pub(crate) fn texture_key(id: egui::TextureId) -> u64 {
    match id {
        egui::TextureId::Managed(n) => n,
        egui::TextureId::User(n) => n | (1 << 63),
    }
}

impl PanelGpu {
    pub(crate) fn new(
        device: &ash::Device,
        memory_properties: &vk::PhysicalDeviceMemoryProperties,
        render_pass: vk::RenderPass,
        views_layout: vk::DescriptorSetLayout,
        extent: vk::Extent2D,
        images: usize,
        mipmapped: bool,
    ) -> Result<Self> {
        // Trilinear: linear within a level and between the two nearest, over the whole chain.
        // No anisotropy, which would sharpen text seen at a slant further, because the device is
        // created without the samplerAnisotropy feature and a sampler may not ask for it then.
        let sampler = unsafe {
            device.create_sampler(
                &vk::SamplerCreateInfo::default()
                    .mag_filter(vk::Filter::LINEAR)
                    .min_filter(vk::Filter::LINEAR)
                    .mipmap_mode(vk::SamplerMipmapMode::LINEAR)
                    .min_lod(0.0)
                    .max_lod(vk::LOD_CLAMP_NONE)
                    .address_mode_u(vk::SamplerAddressMode::CLAMP_TO_EDGE)
                    .address_mode_v(vk::SamplerAddressMode::CLAMP_TO_EDGE)
                    .address_mode_w(vk::SamplerAddressMode::CLAMP_TO_EDGE),
                None,
            )
        }?;
        let set_layout = unsafe {
            device.create_descriptor_set_layout(
                &vk::DescriptorSetLayoutCreateInfo::default().bindings(&[
                    vk::DescriptorSetLayoutBinding::default()
                        .binding(0)
                        .descriptor_type(vk::DescriptorType::COMBINED_IMAGE_SAMPLER)
                        .descriptor_count(1)
                        .stage_flags(vk::ShaderStageFlags::FRAGMENT),
                ]),
                None,
            )
        }?;
        let pool = unsafe {
            device.create_descriptor_pool(
                &vk::DescriptorPoolCreateInfo::default()
                    .flags(vk::DescriptorPoolCreateFlags::FREE_DESCRIPTOR_SET)
                    .max_sets(16)
                    .pool_sizes(&[vk::DescriptorPoolSize::default()
                        .ty(vk::DescriptorType::COMBINED_IMAGE_SAMPLER)
                        .descriptor_count(16)]),
                None,
            )
        }?;
        // The placement's matrix for the vertices, then the mesh's clip rectangle for the
        // fragments, in ranges of their own so that each is pushed without the other.
        let push = [
            vk::PushConstantRange::default()
                .stage_flags(vk::ShaderStageFlags::VERTEX)
                .offset(0)
                .size(PANEL_CLIP_OFFSET),
            vk::PushConstantRange::default()
                .stage_flags(vk::ShaderStageFlags::FRAGMENT)
                .offset(PANEL_CLIP_OFFSET)
                .size(16),
        ];
        let layout = unsafe {
            device.create_pipeline_layout(
                &vk::PipelineLayoutCreateInfo::default()
                    .set_layouts(&[views_layout, set_layout])
                    .push_constant_ranges(&push),
                None,
            )
        }?;
        let pipeline = build_panel_pipeline(device, render_pass, layout, extent)?;
        let mut per_target = Vec::with_capacity(images);
        for _ in 0..images {
            per_target.push((
                Buffer::new(device, memory_properties, PANEL_VERTICES * 20, vk::BufferUsageFlags::VERTEX_BUFFER)?,
                Buffer::new(device, memory_properties, PANEL_INDICES * 4, vk::BufferUsageFlags::INDEX_BUFFER)?,
            ));
        }
        Ok(Self {
            pipeline,
            layout,
            set_layout,
            pool,
            sampler,
            mipmapped,
            textures: std::collections::HashMap::new(),
            per_target,
        })
    }

    /// An empty sRGB texture of `size` with room for its mip chain, with its descriptor set;
    /// `upload_texture` fills it.
    pub(crate) fn create_texture(
        &self,
        device: &ash::Device,
        memory_properties: &vk::PhysicalDeviceMemoryProperties,
        size: [usize; 2],
        pixels: Vec<u8>,
    ) -> Result<Texture> {
        let levels = mip_levels(size, self.mipmapped);
        // TRANSFER_SRC as well when there is a chain: each level is blitted from the one above.
        let usage = if levels > 1 {
            vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST | vk::ImageUsageFlags::TRANSFER_SRC
        } else {
            vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST
        };
        let image = unsafe {
            device.create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(PANEL_TEXTURE_FORMAT)
                    .extent(vk::Extent3D {
                        width: size[0] as u32,
                        height: size[1] as u32,
                        depth: 1,
                    })
                    .mip_levels(levels)
                    .array_layers(1)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(usage)
                    .initial_layout(vk::ImageLayout::UNDEFINED),
                None,
            )
        }?;
        let needs = unsafe { device.get_image_memory_requirements(image) };
        let memory = allocate(device, memory_properties, needs, vk::MemoryPropertyFlags::DEVICE_LOCAL)?;
        unsafe { device.bind_image_memory(image, memory, 0) }?;
        let view = unsafe {
            device.create_image_view(
                &vk::ImageViewCreateInfo::default()
                    .image(image)
                    .view_type(vk::ImageViewType::TYPE_2D)
                    .format(PANEL_TEXTURE_FORMAT)
                    .subresource_range(
                        vk::ImageSubresourceRange::default()
                            .aspect_mask(vk::ImageAspectFlags::COLOR)
                            .level_count(levels)
                            .layer_count(1),
                    ),
                None,
            )
        }?;
        let set = unsafe {
            device.allocate_descriptor_sets(
                &vk::DescriptorSetAllocateInfo::default()
                    .descriptor_pool(self.pool)
                    .set_layouts(&[self.set_layout]),
            )
        }?[0];
        let info = [vk::DescriptorImageInfo::default()
            .sampler(self.sampler)
            .image_view(view)
            .image_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)];
        unsafe {
            device.update_descriptor_sets(
                &[vk::WriteDescriptorSet::default()
                    .dst_set(set)
                    .dst_binding(0)
                    .descriptor_type(vk::DescriptorType::COMBINED_IMAGE_SAMPLER)
                    .image_info(&info)],
                &[],
            );
        }
        Ok(Texture {
            image,
            memory,
            view,
            set,
            size,
            levels,
            pixels,
        })
    }

    pub(crate) unsafe fn destroy(&self, device: &ash::Device) {
        unsafe {
            for texture in self.textures.values() {
                texture.destroy(device);
            }
            for (vertex, index) in &self.per_target {
                vertex.destroy(device);
                index.destroy(device);
            }
            device.destroy_pipeline(self.pipeline, None);
            device.destroy_pipeline_layout(self.layout, None);
            device.destroy_descriptor_pool(self.pool, None);
            device.destroy_descriptor_set_layout(self.set_layout, None);
            device.destroy_sampler(self.sampler, None);
        }
    }
}

impl Texture {
    pub(crate) unsafe fn destroy(&self, device: &ash::Device) {
        unsafe {
            device.destroy_image_view(self.view, None);
            device.destroy_image(self.image, None);
            device.free_memory(self.memory, None);
        }
    }
}

/// The panel's pipeline: egui's vertex layout, premultiplied blending, depth tested against the
/// body so it sits in the room rather than over it.
fn build_panel_pipeline(
    device: &ash::Device,
    render_pass: vk::RenderPass,
    layout: vk::PipelineLayout,
    extent: vk::Extent2D,
) -> Result<vk::Pipeline> {
    let vertex_module = shader_module(device, include_bytes!("../shaders/panel.vert.spv"))?;
    let fragment_module = shader_module(device, include_bytes!("../shaders/panel.frag.spv"))?;
    let entry = CStr::from_bytes_with_nul(b"main\0")?;
    let stages = [
        vk::PipelineShaderStageCreateInfo::default()
            .stage(vk::ShaderStageFlags::VERTEX)
            .module(vertex_module)
            .name(entry),
        vk::PipelineShaderStageCreateInfo::default()
            .stage(vk::ShaderStageFlags::FRAGMENT)
            .module(fragment_module)
            .name(entry),
    ];
    let bindings = [vk::VertexInputBindingDescription::default()
        .binding(0)
        .stride(20)
        .input_rate(vk::VertexInputRate::VERTEX)];
    let attributes = [
        vk::VertexInputAttributeDescription::default()
            .location(0)
            .format(vk::Format::R32G32_SFLOAT)
            .offset(0),
        vk::VertexInputAttributeDescription::default()
            .location(1)
            .format(vk::Format::R32G32_SFLOAT)
            .offset(8),
        vk::VertexInputAttributeDescription::default()
            .location(2)
            .format(vk::Format::R8G8B8A8_UNORM)
            .offset(16),
    ];
    let vertex_input = vk::PipelineVertexInputStateCreateInfo::default()
        .vertex_binding_descriptions(&bindings)
        .vertex_attribute_descriptions(&attributes);
    let assembly = vk::PipelineInputAssemblyStateCreateInfo::default()
        .topology(vk::PrimitiveTopology::TRIANGLE_LIST);
    let viewports = [vk::Viewport::default()
        .width(extent.width as f32)
        .height(extent.height as f32)
        .max_depth(1.0)];
    let scissors = [vk::Rect2D::default().extent(extent)];
    let viewport = vk::PipelineViewportStateCreateInfo::default()
        .viewports(&viewports)
        .scissors(&scissors);
    let raster = vk::PipelineRasterizationStateCreateInfo::default()
        .polygon_mode(vk::PolygonMode::FILL)
        .cull_mode(vk::CullModeFlags::NONE)
        .front_face(vk::FrontFace::COUNTER_CLOCKWISE)
        .line_width(1.0);
    let multisample = vk::PipelineMultisampleStateCreateInfo::default()
        .rasterization_samples(vk::SampleCountFlags::TYPE_1);
    // Tested against the body so it sits in the room, but never written: every layer of the
    // panel lies in one plane, and layers that wrote depth would fight each other. Drawn last,
    // in egui's order, later layers simply blend over earlier ones.
    let depth_stencil = vk::PipelineDepthStencilStateCreateInfo::default()
        .depth_test_enable(true)
        .depth_write_enable(false)
        .depth_compare_op(vk::CompareOp::LESS);
    let blend_attachments = [vk::PipelineColorBlendAttachmentState::default()
        .blend_enable(true)
        .src_color_blend_factor(vk::BlendFactor::ONE)
        .dst_color_blend_factor(vk::BlendFactor::ONE_MINUS_SRC_ALPHA)
        .color_blend_op(vk::BlendOp::ADD)
        .src_alpha_blend_factor(vk::BlendFactor::ONE)
        .dst_alpha_blend_factor(vk::BlendFactor::ONE_MINUS_SRC_ALPHA)
        .alpha_blend_op(vk::BlendOp::ADD)
        .color_write_mask(vk::ColorComponentFlags::RGBA)];
    let blend = vk::PipelineColorBlendStateCreateInfo::default().attachments(&blend_attachments);
    let create = vk::GraphicsPipelineCreateInfo::default()
        .stages(&stages)
        .vertex_input_state(&vertex_input)
        .input_assembly_state(&assembly)
        .viewport_state(&viewport)
        .rasterization_state(&raster)
        .multisample_state(&multisample)
        .depth_stencil_state(&depth_stencil)
        .color_blend_state(&blend)
        .layout(layout)
        .render_pass(render_pass)
        .subpass(0);
    let pipeline = unsafe {
        device.create_graphics_pipelines(vk::PipelineCache::null(), &[create], None)
    }
    .map_err(|(_, e)| e)?[0];
    unsafe {
        device.destroy_shader_module(vertex_module, None);
        device.destroy_shader_module(fragment_module, None);
    }
    Ok(pipeline)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a SPIR-V module says of its interface: the locations of its inputs and of its
    /// outputs, and every push-constant member offset it declares. Read from the words, since
    /// there is no device in a test to reject a mismatch the way a pipeline build would.
    fn interface(spv: &[u8]) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
        const OP_DECORATE: u32 = 71;
        const OP_MEMBER_DECORATE: u32 = 72;
        const OP_VARIABLE: u32 = 59;
        const LOCATION: u32 = 30;
        const OFFSET: u32 = 35;
        const INPUT: u32 = 1;
        const OUTPUT: u32 = 3;
        let words: Vec<u32> = spv
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        let mut locations = std::collections::HashMap::new();
        let mut classes = std::collections::HashMap::new();
        let mut offsets = Vec::new();
        let mut at = 5;
        while at < words.len() {
            let (count, op) = ((words[at] >> 16) as usize, words[at] & 0xffff);
            let operands = &words[at + 1..at + count];
            match op {
                OP_DECORATE if operands[1] == LOCATION => {
                    locations.insert(operands[0], operands[2]);
                }
                OP_MEMBER_DECORATE if operands[2] == OFFSET => offsets.push(operands[3]),
                OP_VARIABLE => {
                    classes.insert(operands[1], operands[2]);
                }
                _ => {}
            }
            at += count.max(1);
        }
        let of = |class: u32| {
            let mut found: Vec<u32> = locations
                .iter()
                .filter(|(id, _)| classes.get(*id) == Some(&class))
                .map(|(_, location)| *location)
                .collect();
            found.sort_unstable();
            found
        };
        (of(INPUT), of(OUTPUT), offsets)
    }

    #[test]
    fn the_panel_shaders_agree_on_the_point_they_are_cut_by() {
        // The vertex stage hands the panel point on at every location the fragment stage reads,
        // and the fragment stage reads its clip rectangle after the matrix, where `draw` pushes
        // it. Either wrong is a pipeline that builds and draws nothing, or draws the uncut rows.
        let (_, out, _) = interface(include_bytes!("../shaders/panel.vert.spv"));
        let (inputs, _, offsets) = interface(include_bytes!("../shaders/panel.frag.spv"));
        assert_eq!(inputs, vec![0, 1, 2]);
        assert!(inputs.iter().all(|l| out.contains(l)), "vertex out {out:?}, fragment in {inputs:?}");
        assert_eq!(offsets, vec![PANEL_CLIP_OFFSET]);
    }

    #[test]
    fn a_panel_texture_has_its_whole_mip_chain_when_the_device_can_build_it() {
        // egui's font atlas starts 2048 wide: twelve levels, 2048 down to 1. A texture that is
        // not square is counted by its longer side, since its shorter one stops at a texel.
        assert_eq!(mip_levels([2048, 64], true), 12);
        assert_eq!(mip_levels([1000, 150], true), 10);
        assert_eq!(mip_levels([1, 1], true), 1);
        // A device that cannot blit or filter the format keeps the one level it always had.
        assert_eq!(mip_levels([2048, 64], false), 1);
        let all = vk::FormatFeatureFlags::BLIT_SRC
            | vk::FormatFeatureFlags::BLIT_DST
            | vk::FormatFeatureFlags::SAMPLED_IMAGE_FILTER_LINEAR
            | vk::FormatFeatureFlags::SAMPLED_IMAGE;
        assert!(can_mipmap(all));
        assert!(!can_mipmap(all & !vk::FormatFeatureFlags::BLIT_DST));
        assert!(!can_mipmap(all & !vk::FormatFeatureFlags::SAMPLED_IMAGE_FILTER_LINEAR));
    }
}
