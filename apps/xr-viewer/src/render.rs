//! Drawing the skeleton into an OpenXR swapchain, both eyes in one pass.
//!
//! ## The shape of it
//!
//! One vertex buffer and one index buffer holding every bone, because the pack's positions are
//! already in world metres and a rest pose is therefore a single draw call. Each vertex carries
//! the index of the bone it belongs to, and a uniform array holds a transform per bone -- all
//! identity while the pose is static. That attribute is the whole provision for what comes next:
//! feeding real poses is a buffer write rather than a different renderer.
//!
//! ## Multiview, which is the only performance decision here that matters
//!
//! The render pass is created with a view mask of `0b11`, so one recorded draw runs for both eyes
//! and `gl_ViewIndex` tells the vertex shader which projection to use. The alternative -- record
//! everything twice -- costs very nearly twice as much for a scene this size. Two thousand and
//! sixteen by two thousand two hundred and forty, twice, at a hundred and forty-two hertz is nine
//! megapixels a frame and thirteen hundred a second; there is no reason to pay for it twice.
//!
//! ## What is deliberately simple
//!
//! Memory is allocated per resource with no allocator, because there are six allocations. There
//! is no descriptor pool churn: one set, written once. There is no MSAA, because the runtime asks
//! for one sample. None of that is where the time goes at half a million triangles.

use anyhow::{Context, Result, bail};
use ash::vk;
use std::ffi::CStr;

use crate::pack::Pack;

const MAX_BONES: usize = 256;
/// Two transform slots past the last bone hold the tracked controllers, one a hand.
pub const CONTROLLERS: usize = 2;
/// After the controllers and the world slot, one slot a hand for the pointer's mark on the panel.
pub const MARKERS: usize = 2;
/// The edge of a pointer mark, which is a small cube where the aim ray meets the panel.
pub const MARKER_EDGE: f32 = 0.012;
/// After the grid, the scenery: the scenario's static boxes, in the simulation's frame.
pub const SCENE_SLOTS: usize = 1;
/// The floor grid: lines this far apart, out to this far, this wide, all in metres.
const GRID_SPACING: f32 = 0.5;
const GRID_REACH: f32 = 5.0;
const GRID_WIDTH: f32 = 0.006;
/// How many egui vertices and indices a frame of the panel may have; more is cut off.
const PANEL_VERTICES: usize = 32768;
const PANEL_INDICES: usize = 98304;
/// The edge of a controller cube, in metres; a hand-sized thing, not a fingertip.
pub const CONTROLLER_EDGE: f32 = 0.06;
/// Position, normal, bone index.
const VERTEX_BYTES: u32 = 3 * 4 + 3 * 4 + 4;

/// Where the body is put relative to the stage origin, and which way it faces.
///
/// The pack stands the body at the origin with its feet at zero and its front toward -Z, and
/// OpenXR's stage space has the viewer facing -Z as well -- so left alone the two face the same
/// way and you arrive behind it. It is moved a metre and a half out and turned around, which puts
/// you looking at its front from across the room.
const STANDS_AT: [f32; 3] = [0.0, 0.0, -1.5];

pub struct Renderer {
    device: ash::Device,
    queue: vk::Queue,
    render_pass: vk::RenderPass,
    pipeline_layout: vk::PipelineLayout,
    pipeline: vk::Pipeline,
    descriptor_pool: vk::DescriptorPool,
    set_layout: vk::DescriptorSetLayout,
    command_pool: vk::CommandPool,

    vertex: Buffer,
    index: Buffer,
    index_count: u32,
    /// `pack.bones.len()`: the controllers' slots begin here, and the world slot is after them.
    first_controller: usize,
    memory_properties: vk::PhysicalDeviceMemoryProperties,
    /// The muscle tubes, once a bridge has said how many rings there are.
    muscles: Option<Muscles>,
    /// The scenery, rebuilt whenever the publisher's generation changes.
    scene: Option<(Buffer, Buffer, u32)>,
    panel: PanelGpu,

    depth: Image,
    targets: Vec<Target>,
    extent: vk::Extent2D,
}

/// Everything that belongs to one swapchain image, including its own copy of both uniform buffers.
///
/// Per image rather than shared, because a shared buffer written for frame N+1 while the GPU is
/// still reading it for frame N tears -- and the fence that says frame N is finished belongs to
/// frame N's image, not to whichever one is being recorded now. Three copies of thirteen
/// kilobytes is the whole cost of not having that bug.
struct Target {
    view: vk::ImageView,
    framebuffer: vk::Framebuffer,
    command_buffer: vk::CommandBuffer,
    fence: vk::Fence,
    views_ubo: Buffer,
    bones_ubo: Buffer,
    descriptor_set: vk::DescriptorSet,
}

/// The swept muscle tubes: a fixed index buffer, and a vertex buffer per swapchain image that is
/// rewritten from the newest rings each frame, for the same reason the uniform buffers are per
/// image.
struct Muscles {
    index: Buffer,
    index_count: u32,
    vertex_floats: usize,
    per_target: Vec<Buffer>,
    /// Whether each image's buffer has ever been filled; an unfilled one is not drawn.
    filled: Vec<std::cell::Cell<bool>>,
}

/// What draws the panel: its own pipeline over the same render pass, a sampler and a set layout
/// for egui's textures, a texture per egui texture id, and per-image vertex and index buffers.
struct PanelGpu {
    pipeline: vk::Pipeline,
    layout: vk::PipelineLayout,
    set_layout: vk::DescriptorSetLayout,
    pool: vk::DescriptorPool,
    sampler: vk::Sampler,
    textures: std::collections::HashMap<u64, Texture>,
    per_target: Vec<(Buffer, Buffer)>,
}

/// One egui texture on the GPU, with the CPU copy that partial updates are patched into.
struct Texture {
    image: vk::Image,
    memory: vk::DeviceMemory,
    view: vk::ImageView,
    set: vk::DescriptorSet,
    size: [usize; 2],
    pixels: Vec<u8>,
}

/// The panel as `draw` wants it: the matrix that stands it up, and egui's meshes.
pub struct PanelDraw<'a> {
    pub model: [f32; 16],
    pub meshes: &'a [(egui::TextureId, Vec<egui::epaint::Vertex>, Vec<u32>)],
}

struct Buffer {
    handle: vk::Buffer,
    memory: vk::DeviceMemory,
    mapped: *mut std::ffi::c_void,
}

struct Image {
    handle: vk::Image,
    memory: vk::DeviceMemory,
    view: vk::ImageView,
}

impl Renderer {
    /// Build everything that does not change from frame to frame.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        instance: &ash::Instance,
        physical: vk::PhysicalDevice,
        device: ash::Device,
        queue_family: u32,
        format: vk::Format,
        extent: vk::Extent2D,
        swapchain_images: &[vk::Image],
        pack: &Pack,
    ) -> Result<Self> {
        let queue = unsafe { device.get_device_queue(queue_family, 0) };
        let memory_properties =
            unsafe { instance.get_physical_device_memory_properties(physical) };

        // --- geometry, flattened into one pair of buffers -------------------------------------
        let (vertices, indices) = flatten(pack);
        if pack.bones.len() + CONTROLLERS + 1 + MARKERS + 1 + SCENE_SLOTS > MAX_BONES {
            bail!(
                "the pack has {} bones, and with the controllers, markers and world slot the shader holds {MAX_BONES}.",
                pack.bones.len()
            );
        }
        let index_count = indices.len() as u32;
        let vertex = Buffer::new(
            &device,
            &memory_properties,
            std::mem::size_of_val(&vertices[..]),
            vk::BufferUsageFlags::VERTEX_BUFFER,
        )?;
        let index = Buffer::new(
            &device,
            &memory_properties,
            std::mem::size_of_val(&indices[..]),
            vk::BufferUsageFlags::INDEX_BUFFER,
        )?;
        vertex.write(bytes_of(&vertices));
        index.write(bytes_of(&indices));

        // Every bone starts where the placement puts the rest pose; a followed simulation
        // overwrites this every frame, and a static view never touches it again.
        let mut model = [0f32; MAX_BONES * 16];
        let placed = placement(0.0);
        for bone in 0..MAX_BONES {
            model[bone * 16..bone * 16 + 16].copy_from_slice(&placed);
        }

        // --- render pass, with both eyes in one subpass ----------------------------------------
        let render_pass = multiview_render_pass(&device, format)?;

        // --- pipeline --------------------------------------------------------------------------
        let set_layout = unsafe {
            device.create_descriptor_set_layout(
                &vk::DescriptorSetLayoutCreateInfo::default().bindings(&[
                    vk::DescriptorSetLayoutBinding::default()
                        .binding(0)
                        .descriptor_type(vk::DescriptorType::UNIFORM_BUFFER)
                        .descriptor_count(1)
                        .stage_flags(vk::ShaderStageFlags::VERTEX),
                    vk::DescriptorSetLayoutBinding::default()
                        .binding(1)
                        .descriptor_type(vk::DescriptorType::UNIFORM_BUFFER)
                        .descriptor_count(1)
                        .stage_flags(vk::ShaderStageFlags::VERTEX),
                ]),
                None,
            )
        }?;
        let push = [vk::PushConstantRange::default()
            .stage_flags(vk::ShaderStageFlags::FRAGMENT)
            .offset(0)
            .size(16)];
        let pipeline_layout = unsafe {
            device.create_pipeline_layout(
                &vk::PipelineLayoutCreateInfo::default()
                    .set_layouts(&[set_layout])
                    .push_constant_ranges(&push),
                None,
            )
        }?;
        let pipeline = build_pipeline(&device, render_pass, pipeline_layout, extent)?;
        let panel = PanelGpu::new(&device, &memory_properties, render_pass, set_layout, extent, swapchain_images.len())?;

        let images = swapchain_images.len() as u32;
        let descriptor_pool = unsafe {
            device.create_descriptor_pool(
                &vk::DescriptorPoolCreateInfo::default()
                    .max_sets(images)
                    .pool_sizes(&[vk::DescriptorPoolSize::default()
                        .ty(vk::DescriptorType::UNIFORM_BUFFER)
                        .descriptor_count(2 * images)]),
                None,
            )
        }?;

        // --- depth, shared by every swapchain image ---------------------------------------------
        let depth = Image::depth(&device, &memory_properties, extent)?;

        // --- one framebuffer, command buffer and fence per swapchain image ----------------------
        let command_pool = unsafe {
            device.create_command_pool(
                &vk::CommandPoolCreateInfo::default()
                    .queue_family_index(queue_family)
                    .flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER),
                None,
            )
        }?;
        let command_buffers = unsafe {
            device.allocate_command_buffers(
                &vk::CommandBufferAllocateInfo::default()
                    .command_pool(command_pool)
                    .level(vk::CommandBufferLevel::PRIMARY)
                    .command_buffer_count(swapchain_images.len() as u32),
            )
        }?;
        let mut targets = Vec::with_capacity(swapchain_images.len());
        for (at, image) in swapchain_images.iter().enumerate() {
            let view = unsafe {
                device.create_image_view(
                    &vk::ImageViewCreateInfo::default()
                        .image(*image)
                        // An array view because the swapchain is two layers, one an eye, and
                        // multiview indexes those layers rather than binding them separately.
                        .view_type(vk::ImageViewType::TYPE_2D_ARRAY)
                        .format(format)
                        .subresource_range(
                            vk::ImageSubresourceRange::default()
                                .aspect_mask(vk::ImageAspectFlags::COLOR)
                                .level_count(1)
                                .layer_count(2),
                        ),
                    None,
                )
            }?;
            let framebuffer = unsafe {
                device.create_framebuffer(
                    &vk::FramebufferCreateInfo::default()
                        .render_pass(render_pass)
                        .attachments(&[view, depth.view])
                        .width(extent.width)
                        .height(extent.height)
                        // One, not two: with multiview the layers come from the view mask, and a
                        // framebuffer that also claims two is invalid.
                        .layers(1),
                    None,
                )
            }?;
            // This image's own uniform buffers and the set that points at them.
            let views_ubo = Buffer::new(
                &device,
                &memory_properties,
                2 * 64,
                vk::BufferUsageFlags::UNIFORM_BUFFER,
            )?;
            let bones_ubo = Buffer::new(
                &device,
                &memory_properties,
                MAX_BONES * 64,
                vk::BufferUsageFlags::UNIFORM_BUFFER,
            )?;
            bones_ubo.write(bytes_of(&model));
            let descriptor_set = unsafe {
                device.allocate_descriptor_sets(
                    &vk::DescriptorSetAllocateInfo::default()
                        .descriptor_pool(descriptor_pool)
                        .set_layouts(&[set_layout]),
                )
            }?[0];
            let view_info = [vk::DescriptorBufferInfo::default()
                .buffer(views_ubo.handle)
                .range(vk::WHOLE_SIZE)];
            let bone_info = [vk::DescriptorBufferInfo::default()
                .buffer(bones_ubo.handle)
                .range(vk::WHOLE_SIZE)];
            unsafe {
                device.update_descriptor_sets(
                    &[
                        vk::WriteDescriptorSet::default()
                            .dst_set(descriptor_set)
                            .dst_binding(0)
                            .descriptor_type(vk::DescriptorType::UNIFORM_BUFFER)
                            .buffer_info(&view_info),
                        vk::WriteDescriptorSet::default()
                            .dst_set(descriptor_set)
                            .dst_binding(1)
                            .descriptor_type(vk::DescriptorType::UNIFORM_BUFFER)
                            .buffer_info(&bone_info),
                    ],
                    &[],
                );
            }
            targets.push(Target {
                view,
                framebuffer,
                command_buffer: command_buffers[at],
                fence: unsafe {
                    device.create_fence(
                        &vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED),
                        None,
                    )
                }?,
                views_ubo,
                bones_ubo,
                descriptor_set,
            });
        }

        Ok(Self {
            device,
            queue,
            render_pass,
            pipeline_layout,
            pipeline,
            descriptor_pool,
            set_layout,
            command_pool,
            vertex,
            index,
            index_count,
            first_controller: pack.bones.len(),
            memory_properties,
            muscles: None,
            scene: None,
            panel,
            depth,
            targets,
            extent,
        })
    }

    /// Record and submit one frame into the given swapchain image.
    ///
    /// `bones` is one matrix per pack bone followed by one per controller, or `None` to leave
    /// whatever this image's buffer last held -- the placement, for a viewer showing nothing live.
    ///
    /// `muscles` is the swept tube vertices from `tube_vertices`, or `None` to draw what this
    /// image's buffer last held; nothing is drawn until it has held something.
    pub fn draw(
        &self,
        image: usize,
        view_projections: &[f32; 32],
        bones: Option<&[[f32; 16]]>,
        muscles: Option<&[f32]>,
        panel: Option<&PanelDraw>,
    ) -> Result<()> {
        let target = &self.targets[image];
        let device = &self.device;
        unsafe {
            // Only after the fence: this image's buffers are read by the frame this fence
            // belongs to, and writing them any earlier is the tear the per-image copies exist to
            // prevent.
            device.wait_for_fences(&[target.fence], true, u64::MAX)?;
            device.reset_fences(&[target.fence])?;
            target.views_ubo.write(bytes_of(view_projections));
            if let Some(bones) = bones {
                let count = bones.len().min(MAX_BONES);
                target.bones_ubo.write(bytes_of(&bones[..count]));
            }
            if let (Some(tubes), Some(vertices)) = (&self.muscles, muscles) {
                if vertices.len() == tubes.vertex_floats {
                    tubes.per_target[image].write(bytes_of(vertices));
                    tubes.filled[image].set(true);
                }
            }
            // The panel's meshes, packed end to end into this image's buffers, remembering where
            // each begins so it can be drawn with its own texture.
            let mut panel_draws: Vec<(u64, u32, u32, i32)> = Vec::new();
            if let Some(panel) = panel {
                let (vertex_buffer, index_buffer) = &self.panel.per_target[image];
                let mut vertex_at = 0usize;
                let mut index_at = 0usize;
                for (texture, vertices, indices) in panel.meshes {
                    let key = texture_key(*texture);
                    if !self.panel.textures.contains_key(&key)
                        || vertex_at + vertices.len() > PANEL_VERTICES
                        || index_at + indices.len() > PANEL_INDICES
                    {
                        continue;
                    }
                    vertex_buffer.write_at(vertex_at * 20, bytes_of(vertices));
                    index_buffer.write_at(index_at * 4, bytes_of(indices));
                    panel_draws.push((key, index_at as u32, indices.len() as u32, vertex_at as i32));
                    vertex_at += vertices.len();
                    index_at += indices.len();
                }
            }
            device.reset_command_buffer(
                target.command_buffer,
                vk::CommandBufferResetFlags::empty(),
            )?;
            device.begin_command_buffer(
                target.command_buffer,
                &vk::CommandBufferBeginInfo::default()
                    .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
            )?;
            let clears = [
                vk::ClearValue {
                    color: vk::ClearColorValue {
                        float32: [0.04, 0.05, 0.06, 1.0],
                    },
                },
                vk::ClearValue {
                    depth_stencil: vk::ClearDepthStencilValue {
                        depth: 1.0,
                        stencil: 0,
                    },
                },
            ];
            device.cmd_begin_render_pass(
                target.command_buffer,
                &vk::RenderPassBeginInfo::default()
                    .render_pass(self.render_pass)
                    .framebuffer(target.framebuffer)
                    .render_area(vk::Rect2D::default().extent(self.extent))
                    .clear_values(&clears),
                vk::SubpassContents::INLINE,
            );
            device.cmd_bind_pipeline(
                target.command_buffer,
                vk::PipelineBindPoint::GRAPHICS,
                self.pipeline,
            );
            device.cmd_bind_descriptor_sets(
                target.command_buffer,
                vk::PipelineBindPoint::GRAPHICS,
                self.pipeline_layout,
                0,
                &[target.descriptor_set],
                &[],
            );
            device.cmd_push_constants(
                target.command_buffer,
                self.pipeline_layout,
                vk::ShaderStageFlags::FRAGMENT,
                0,
                bytes_of(&[
                    self.first_controller as u32,
                    self.world_slot() as u32,
                    self.stage_slot() as u32,
                    self.scene_slot() as u32,
                ]),
            );
            device.cmd_bind_vertex_buffers(target.command_buffer, 0, &[self.vertex.handle], &[0]);
            device.cmd_bind_index_buffer(
                target.command_buffer,
                self.index.handle,
                0,
                vk::IndexType::UINT32,
            );
            // Every bone and both controllers, both eyes, one call.
            device.cmd_draw_indexed(target.command_buffer, self.index_count, 1, 0, 0, 0);
            // And the muscles, a second call on the same pipeline: their vertices carry the world
            // slot, whose matrix is the placement alone.
            if let Some(tubes) = &self.muscles {
                if tubes.filled[image].get() {
                    device.cmd_bind_vertex_buffers(
                        target.command_buffer,
                        0,
                        &[tubes.per_target[image].handle],
                        &[0],
                    );
                    device.cmd_bind_index_buffer(
                        target.command_buffer,
                        tubes.index.handle,
                        0,
                        vk::IndexType::UINT32,
                    );
                    device.cmd_draw_indexed(target.command_buffer, tubes.index_count, 1, 0, 0, 0);
                }
            }
            // The scenery, in the simulation's frame like the muscles.
            if let Some((vertex, index, count)) = &self.scene {
                device.cmd_bind_vertex_buffers(target.command_buffer, 0, &[vertex.handle], &[0]);
                device.cmd_bind_index_buffer(target.command_buffer, index.handle, 0, vk::IndexType::UINT32);
                device.cmd_draw_indexed(target.command_buffer, *count, 1, 0, 0, 0);
            }
            // And the panel, on its own pipeline: blended, textured, one draw a mesh.
            if let Some(panel) = panel {
                if !panel_draws.is_empty() {
                    let (vertex_buffer, index_buffer) = &self.panel.per_target[image];
                    device.cmd_bind_pipeline(
                        target.command_buffer,
                        vk::PipelineBindPoint::GRAPHICS,
                        self.panel.pipeline,
                    );
                    device.cmd_bind_descriptor_sets(
                        target.command_buffer,
                        vk::PipelineBindPoint::GRAPHICS,
                        self.panel.layout,
                        0,
                        &[target.descriptor_set],
                        &[],
                    );
                    device.cmd_push_constants(
                        target.command_buffer,
                        self.panel.layout,
                        vk::ShaderStageFlags::VERTEX,
                        0,
                        bytes_of(&panel.model),
                    );
                    device.cmd_bind_vertex_buffers(target.command_buffer, 0, &[vertex_buffer.handle], &[0]);
                    device.cmd_bind_index_buffer(
                        target.command_buffer,
                        index_buffer.handle,
                        0,
                        vk::IndexType::UINT32,
                    );
                    for (key, first_index, count, vertex_offset) in &panel_draws {
                        let texture = &self.panel.textures[key];
                        device.cmd_bind_descriptor_sets(
                            target.command_buffer,
                            vk::PipelineBindPoint::GRAPHICS,
                            self.panel.layout,
                            1,
                            &[texture.set],
                            &[],
                        );
                        device.cmd_draw_indexed(
                            target.command_buffer,
                            *count,
                            1,
                            *first_index,
                            *vertex_offset,
                            0,
                        );
                    }
                }
            }
            device.cmd_end_render_pass(target.command_buffer);
            device.end_command_buffer(target.command_buffer)?;
            device.queue_submit(
                self.queue,
                &[vk::SubmitInfo::default().command_buffers(&[target.command_buffer])],
                target.fence,
            )?;
        }
        Ok(())
    }

    /// The transform slot a controller's cube is drawn by; `hand` is 0 left, 1 right.
    pub fn controller_slot(&self, hand: usize) -> usize {
        self.first_controller + hand
    }

    /// The slot whose matrix is the placement alone: what vertices already in the simulation's
    /// world frame are drawn by.
    pub fn world_slot(&self) -> usize {
        self.first_controller + CONTROLLERS
    }

    /// The slot the floor grid is drawn by: its matrix is the identity, the stage itself.
    pub fn stage_slot(&self) -> usize {
        self.world_slot() + 1 + MARKERS
    }

    /// The slot the scenery is drawn by; its matrix is the placement, like the world slot's.
    pub fn scene_slot(&self) -> usize {
        self.stage_slot() + 1
    }

    /// Replace the scenery with these boxes. Waits for the device, which is fine for something
    /// that happens when a scenario changes.
    pub fn set_scene(&mut self, boxes: &[crate::bridge::StaticBox]) -> Result<()> {
        unsafe {
            let _ = self.device.device_wait_idle();
            if let Some((vertex, index, _)) = self.scene.take() {
                vertex.destroy(&self.device);
                index.destroy(&self.device);
            }
        }
        if boxes.is_empty() {
            return Ok(());
        }
        let mut vertices = Vec::new();
        let mut indices = Vec::new();
        for b in boxes {
            posed_box(self.scene_slot() as u32, b, &mut vertices, &mut indices);
        }
        let vertex = Buffer::new(
            &self.device,
            &self.memory_properties,
            std::mem::size_of_val(&vertices[..]),
            vk::BufferUsageFlags::VERTEX_BUFFER,
        )?;
        let index = Buffer::new(
            &self.device,
            &self.memory_properties,
            std::mem::size_of_val(&indices[..]),
            vk::BufferUsageFlags::INDEX_BUFFER,
        )?;
        vertex.write(bytes_of(&vertices));
        index.write(bytes_of(&indices));
        self.scene = Some((vertex, index, indices.len() as u32));
        Ok(())
    }

    /// The slot a hand's pointer mark is drawn by.
    pub fn marker_slot(&self, hand: usize) -> usize {
        self.world_slot() + 1 + hand
    }

    /// Apply egui's texture changes: new textures, patches to existing ones, and frees. Called
    /// before the frame that uses them; it waits for the queue, which is fine for something that
    /// happens a handful of times in a session.
    pub fn update_panel_textures(&mut self, delta: &egui::TexturesDelta) -> Result<()> {
        for (id, image_delta) in &delta.set {
            let key = texture_key(*id);
            let (size, pixels): ([usize; 2], Vec<u8>) = match &image_delta.image {
                egui::epaint::ImageData::Color(image) => (
                    image.size,
                    image.pixels.iter().flat_map(|c| c.to_array()).collect(),
                ),
                egui::epaint::ImageData::Font(image) => (
                    image.size,
                    image.srgba_pixels(None).flat_map(|c| c.to_array()).collect(),
                ),
            };
            match (image_delta.pos, self.panel.textures.get_mut(&key)) {
                (Some([x, y]), Some(existing)) => {
                    // A patch: into the CPU copy, then the whole thing back up. Font atlases
                    // grow a few times early on and then never; simplicity wins here.
                    for row in 0..size[1] {
                        let dst = ((y + row) * existing.size[0] + x) * 4;
                        let src = row * size[0] * 4;
                        existing.pixels[dst..dst + size[0] * 4]
                            .copy_from_slice(&pixels[src..src + size[0] * 4]);
                    }
                    let (image, full_size, full_pixels) =
                        (existing.image, existing.size, existing.pixels.clone());
                    self.upload_texture(image, full_size, &full_pixels)?;
                }
                _ => {
                    if let Some(old) = self.panel.textures.remove(&key) {
                        unsafe {
                            let _ = self.device.queue_wait_idle(self.queue);
                            old.destroy(&self.device);
                        }
                    }
                    let texture = self.panel.create_texture(&self.device, &self.memory_properties, size, pixels)?;
                    self.upload_texture(texture.image, texture.size, &texture.pixels)?;
                    self.panel.textures.insert(key, texture);
                }
            }
        }
        for id in &delta.free {
            if let Some(old) = self.panel.textures.remove(&texture_key(*id)) {
                unsafe {
                    let _ = self.device.queue_wait_idle(self.queue);
                    old.destroy(&self.device);
                }
            }
        }
        Ok(())
    }

    /// Copy pixels into an image through a staging buffer, with the layout transitions round it.
    fn upload_texture(&self, image: vk::Image, size: [usize; 2], pixels: &[u8]) -> Result<()> {
        let device = &self.device;
        let staging = Buffer::new(
            device,
            &self.memory_properties,
            pixels.len(),
            vk::BufferUsageFlags::TRANSFER_SRC,
        )?;
        staging.write(pixels);
        let command = unsafe {
            device.allocate_command_buffers(
                &vk::CommandBufferAllocateInfo::default()
                    .command_pool(self.command_pool)
                    .level(vk::CommandBufferLevel::PRIMARY)
                    .command_buffer_count(1),
            )
        }?[0];
        let range = vk::ImageSubresourceRange::default()
            .aspect_mask(vk::ImageAspectFlags::COLOR)
            .level_count(1)
            .layer_count(1);
        unsafe {
            device.begin_command_buffer(
                command,
                &vk::CommandBufferBeginInfo::default()
                    .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
            )?;
            device.cmd_pipeline_barrier(
                command,
                vk::PipelineStageFlags::TOP_OF_PIPE | vk::PipelineStageFlags::FRAGMENT_SHADER,
                vk::PipelineStageFlags::TRANSFER,
                vk::DependencyFlags::empty(),
                &[],
                &[],
                &[vk::ImageMemoryBarrier::default()
                    .image(image)
                    .old_layout(vk::ImageLayout::UNDEFINED)
                    .new_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
                    .src_access_mask(vk::AccessFlags::SHADER_READ)
                    .dst_access_mask(vk::AccessFlags::TRANSFER_WRITE)
                    .subresource_range(range)],
            );
            device.cmd_copy_buffer_to_image(
                command,
                staging.handle,
                image,
                vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                &[vk::BufferImageCopy::default()
                    .image_subresource(
                        vk::ImageSubresourceLayers::default()
                            .aspect_mask(vk::ImageAspectFlags::COLOR)
                            .layer_count(1),
                    )
                    .image_extent(vk::Extent3D {
                        width: size[0] as u32,
                        height: size[1] as u32,
                        depth: 1,
                    })],
            );
            device.cmd_pipeline_barrier(
                command,
                vk::PipelineStageFlags::TRANSFER,
                vk::PipelineStageFlags::FRAGMENT_SHADER,
                vk::DependencyFlags::empty(),
                &[],
                &[],
                &[vk::ImageMemoryBarrier::default()
                    .image(image)
                    .old_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
                    .new_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)
                    .src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
                    .dst_access_mask(vk::AccessFlags::SHADER_READ)
                    .subresource_range(range)],
            );
            device.end_command_buffer(command)?;
            device.queue_submit(
                self.queue,
                &[vk::SubmitInfo::default().command_buffers(&[command])],
                vk::Fence::null(),
            )?;
            device.queue_wait_idle(self.queue)?;
            device.free_command_buffers(self.command_pool, &[command]);
            staging.destroy(device);
        }
        Ok(())
    }

    /// Make room for the muscle tubes: `units` bellies of `rings` rings, `segments` round each.
    /// The connectivity is fixed from these three numbers and built once here; the vertices come
    /// every frame through `draw`.
    pub fn enable_muscles(&mut self, units: usize, rings: usize, segments: usize) -> Result<()> {
        if let Some(old) = self.muscles.take() {
            unsafe {
                let _ = self.device.device_wait_idle();
                old.index.destroy(&self.device);
                for buffer in &old.per_target {
                    buffer.destroy(&self.device);
                }
            }
        }
        let indices = tube_indices(units, rings, segments);
        let index = Buffer::new(
            &self.device,
            &self.memory_properties,
            std::mem::size_of_val(&indices[..]),
            vk::BufferUsageFlags::INDEX_BUFFER,
        )?;
        index.write(bytes_of(&indices));
        let vertex_floats = units * rings * segments * 7;
        let mut per_target = Vec::with_capacity(self.targets.len());
        for _ in &self.targets {
            per_target.push(Buffer::new(
                &self.device,
                &self.memory_properties,
                vertex_floats * 4,
                vk::BufferUsageFlags::VERTEX_BUFFER,
            )?);
        }
        self.muscles = Some(Muscles {
            index,
            index_count: indices.len() as u32,
            vertex_floats,
            per_target,
            filled: (0..self.targets.len()).map(|_| std::cell::Cell::new(false)).collect(),
        });
        Ok(())
    }

    pub fn wait_idle(&self) {
        unsafe { let _ = self.device.device_wait_idle(); }
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        unsafe {
            let _ = self.device.device_wait_idle();
            for target in &self.targets {
                self.device.destroy_fence(target.fence, None);
                self.device.destroy_framebuffer(target.framebuffer, None);
                self.device.destroy_image_view(target.view, None);
                target.views_ubo.destroy(&self.device);
                target.bones_ubo.destroy(&self.device);
            }
            self.device.destroy_command_pool(self.command_pool, None);
            self.device.destroy_descriptor_pool(self.descriptor_pool, None);
            self.device.destroy_descriptor_set_layout(self.set_layout, None);
            self.device.destroy_pipeline(self.pipeline, None);
            self.device.destroy_pipeline_layout(self.pipeline_layout, None);
            self.device.destroy_render_pass(self.render_pass, None);
            self.depth.destroy(&self.device);
            for buffer in [&self.vertex, &self.index] {
                buffer.destroy(&self.device);
            }
            if let Some(tubes) = &self.muscles {
                tubes.index.destroy(&self.device);
                for buffer in &tubes.per_target {
                    buffer.destroy(&self.device);
                }
            }
            if let Some((vertex, index, _)) = &self.scene {
                vertex.destroy(&self.device);
                index.destroy(&self.device);
            }
            self.panel.destroy(&self.device);
        }
    }
}

/// Every bone's vertices and indices in one pair of buffers, indices rebased as they are copied,
/// and a cube for each controller after them in slots `bones.len()` and up.
fn flatten(pack: &Pack) -> (Vec<f32>, Vec<u32>) {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for (bone, mesh) in pack.bones.iter().enumerate() {
        let base = (vertices.len() / 7) as u32;
        for vertex in mesh.vertices.chunks_exact(6) {
            vertices.extend_from_slice(&vertex[..6]);
            // The bone index rides in the vertex as a bit pattern rather than a number, because
            // the attribute is declared `uint` and this buffer is floats.
            vertices.push(f32::from_bits(bone as u32));
        }
        indices.extend(mesh.indices.iter().map(|i| i + base));
    }
    for hand in 0..CONTROLLERS {
        cube((pack.bones.len() + hand) as u32, CONTROLLER_EDGE, &mut vertices, &mut indices);
    }
    // Past the world slot, a mark for each hand's pointer, and after those the floor grid.
    for hand in 0..MARKERS {
        cube(
            (pack.bones.len() + CONTROLLERS + 1 + hand) as u32,
            MARKER_EDGE,
            &mut vertices,
            &mut indices,
        );
    }
    grid((pack.bones.len() + CONTROLLERS + 1 + MARKERS) as u32, &mut vertices, &mut indices);
    (vertices, indices)
}

/// A static box as six flat faces, its half extents turned by its rotation and carried to its
/// position, all in the simulation's frame.
fn posed_box(slot: u32, b: &crate::bridge::StaticBox, vertices: &mut Vec<f32>, indices: &mut Vec<u32>) {
    let r = rotation(b.rotation);
    let turn = |v: [f32; 3]| {
        [
            r[0] * v[0] + r[3] * v[1] + r[6] * v[2],
            r[1] * v[0] + r[4] * v[1] + r[7] * v[2],
            r[2] * v[0] + r[5] * v[1] + r[8] * v[2],
        ]
    };
    let faces: [([f32; 3], [f32; 3], [f32; 3]); 6] = [
        ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
        ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
        ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ([0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
    ];
    let h = b.half_extents;
    for (n, u, v) in faces {
        let base = (vertices.len() / 7) as u32;
        let normal = turn(n);
        for (su, sv) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
            let local = [
                h[0] * (n[0] + su * u[0] + sv * v[0]),
                h[1] * (n[1] + su * u[1] + sv * v[1]),
                h[2] * (n[2] + su * u[2] + sv * v[2]),
            ];
            let p = turn(local);
            vertices.extend_from_slice(&[
                p[0] + b.position[0],
                p[1] + b.position[1],
                p[2] + b.position[2],
                normal[0],
                normal[1],
                normal[2],
                f32::from_bits(slot),
            ]);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
}

/// The floor: lines every half metre out to five, as flat strips a hair above y = 0 so nothing
/// fights them, the two through the origin twice as wide. Normals up, so the key light lights it.
fn grid(slot: u32, vertices: &mut Vec<f32>, indices: &mut Vec<u32>) {
    let count = (GRID_REACH / GRID_SPACING) as i32;
    let y = 0.001;
    let mut strip = |a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3]| {
        let base = (vertices.len() / 7) as u32;
        for p in [a, b, c, d] {
            vertices.extend_from_slice(&[p[0], p[1], p[2], 0.0, 1.0, 0.0, f32::from_bits(slot)]);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    };
    for i in -count..=count {
        let at = i as f32 * GRID_SPACING;
        let w = if i == 0 { GRID_WIDTH * 2.0 } else { GRID_WIDTH } / 2.0;
        // Along Z at x = at, and along X at z = at.
        strip(
            [at - w, y, -GRID_REACH],
            [at + w, y, -GRID_REACH],
            [at + w, y, GRID_REACH],
            [at - w, y, GRID_REACH],
        );
        strip(
            [-GRID_REACH, y, at - w],
            [GRID_REACH, y, at - w],
            [GRID_REACH, y, at + w],
            [-GRID_REACH, y, at + w],
        );
    }
}

/// egui's texture ids as one number, for the texture map.
fn texture_key(id: egui::TextureId) -> u64 {
    match id {
        egui::TextureId::Managed(n) => n,
        egui::TextureId::User(n) => n | (1 << 63),
    }
}

impl PanelGpu {
    fn new(
        device: &ash::Device,
        memory_properties: &vk::PhysicalDeviceMemoryProperties,
        render_pass: vk::RenderPass,
        views_layout: vk::DescriptorSetLayout,
        extent: vk::Extent2D,
        images: usize,
    ) -> Result<Self> {
        let sampler = unsafe {
            device.create_sampler(
                &vk::SamplerCreateInfo::default()
                    .mag_filter(vk::Filter::LINEAR)
                    .min_filter(vk::Filter::LINEAR)
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
        let push = [vk::PushConstantRange::default()
            .stage_flags(vk::ShaderStageFlags::VERTEX)
            .offset(0)
            .size(64)];
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
            textures: std::collections::HashMap::new(),
            per_target,
        })
    }

    /// An empty sRGB texture of `size`, with its descriptor set; `upload_texture` fills it.
    fn create_texture(
        &self,
        device: &ash::Device,
        memory_properties: &vk::PhysicalDeviceMemoryProperties,
        size: [usize; 2],
        pixels: Vec<u8>,
    ) -> Result<Texture> {
        let image = unsafe {
            device.create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(vk::Format::R8G8B8A8_SRGB)
                    .extent(vk::Extent3D {
                        width: size[0] as u32,
                        height: size[1] as u32,
                        depth: 1,
                    })
                    .mip_levels(1)
                    .array_layers(1)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST)
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
                    .format(vk::Format::R8G8B8A8_SRGB)
                    .subresource_range(
                        vk::ImageSubresourceRange::default()
                            .aspect_mask(vk::ImageAspectFlags::COLOR)
                            .level_count(1)
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
            pixels,
        })
    }

    unsafe fn destroy(&self, device: &ash::Device) {
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
    unsafe fn destroy(&self, device: &ash::Device) {
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

/// The triangles of every belly's tube, which depend only on the counts: ring `r` and ring `r+1`
/// of a unit are joined by a strip of `segments` quads, and units are not joined to each other.
pub fn tube_indices(units: usize, rings: usize, segments: usize) -> Vec<u32> {
    let mut indices = Vec::with_capacity(units * (rings - 1) * segments * 6);
    for unit in 0..units {
        for ring in 0..rings - 1 {
            let a = ((unit * rings + ring) * segments) as u32;
            let b = a + segments as u32;
            for k in 0..segments as u32 {
                let next = (k + 1) % segments as u32;
                indices.extend_from_slice(&[a + k, b + k, b + next, a + k, b + next, a + next]);
            }
        }
    }
    indices
}

/// Sweep every ring into `segments` vertices, seven floats each in the pack's vertex layout, all
/// owned by `slot`. `rings` is eight floats a ring -- centre, orientation, radius -- as the muscle
/// bridge carries them. Vertex `k` of a ring sits at angle `2 pi k / segments` in the ring's own
/// XY plane, and its normal is that same direction: the ring is a circle, so radial is normal.
pub fn tube_vertices(rings: &[f32], segments: usize, slot: u32, out: &mut Vec<f32>) {
    out.clear();
    out.reserve(rings.len() / 8 * segments * 7);
    for ring in rings.chunks_exact(8) {
        let centre = [ring[0], ring[1], ring[2]];
        let r = rotation([ring[3], ring[4], ring[5], ring[6]]);
        let radius = ring[7];
        for k in 0..segments {
            let angle = std::f32::consts::TAU * k as f32 / segments as f32;
            let (sin, cos) = angle.sin_cos();
            // The ring's X and Y columns, mixed by the angle: column-major, so X is r[0..3].
            let n = [
                r[0] * cos + r[3] * sin,
                r[1] * cos + r[4] * sin,
                r[2] * cos + r[5] * sin,
            ];
            out.extend_from_slice(&[
                centre[0] + radius * n[0],
                centre[1] + radius * n[1],
                centre[2] + radius * n[2],
                n[0],
                n[1],
                n[2],
                f32::from_bits(slot),
            ]);
        }
    }
}

/// A cube of edge `edge` about the origin, six flat-shaded faces, owned by one slot.
/// The slot's matrix is the grip pose, so the cube sits in the hand wherever the hand is.
fn cube(slot: u32, edge: f32, vertices: &mut Vec<f32>, indices: &mut Vec<u32>) {
    let h = edge / 2.0;
    // (normal, u, v) with u x v = normal, so the corners below wind the same way every face.
    let faces: [([f32; 3], [f32; 3], [f32; 3]); 6] = [
        ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
        ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
        ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ([0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
    ];
    for (n, u, v) in faces {
        let base = (vertices.len() / 7) as u32;
        for (su, sv) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
            for axis in 0..3 {
                vertices.push(h * (n[axis] + su * u[axis] + sv * v[axis]));
            }
            vertices.extend_from_slice(&n);
            vertices.push(f32::from_bits(slot));
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
}

fn multiview_render_pass(device: &ash::Device, format: vk::Format) -> Result<vk::RenderPass> {
    let attachments = [
        vk::AttachmentDescription::default()
            .format(format)
            .samples(vk::SampleCountFlags::TYPE_1)
            .load_op(vk::AttachmentLoadOp::CLEAR)
            .store_op(vk::AttachmentStoreOp::STORE)
            .initial_layout(vk::ImageLayout::UNDEFINED)
            .final_layout(vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL),
        vk::AttachmentDescription::default()
            .format(vk::Format::D32_SFLOAT)
            .samples(vk::SampleCountFlags::TYPE_1)
            .load_op(vk::AttachmentLoadOp::CLEAR)
            .store_op(vk::AttachmentStoreOp::DONT_CARE)
            .initial_layout(vk::ImageLayout::UNDEFINED)
            .final_layout(vk::ImageLayout::DEPTH_STENCIL_ATTACHMENT_OPTIMAL),
    ];
    let colour = [vk::AttachmentReference::default()
        .attachment(0)
        .layout(vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL)];
    let depth = vk::AttachmentReference::default()
        .attachment(1)
        .layout(vk::ImageLayout::DEPTH_STENCIL_ATTACHMENT_OPTIMAL);
    let subpasses = [vk::SubpassDescription::default()
        .pipeline_bind_point(vk::PipelineBindPoint::GRAPHICS)
        .color_attachments(&colour)
        .depth_stencil_attachment(&depth)];

    // The mask is the whole of multiview: bit per view, so 0b11 is both eyes. The correlation mask
    // tells the driver the two views are near each other, which is what lets it share work.
    let view_masks = [0b11u32];
    let correlation_masks = [0b11u32];
    let mut multiview = vk::RenderPassMultiviewCreateInfo::default()
        .view_masks(&view_masks)
        .correlation_masks(&correlation_masks);

    Ok(unsafe {
        device.create_render_pass(
            &vk::RenderPassCreateInfo::default()
                .attachments(&attachments)
                .subpasses(&subpasses)
                .push_next(&mut multiview),
            None,
        )
    }?)
}

fn build_pipeline(
    device: &ash::Device,
    render_pass: vk::RenderPass,
    layout: vk::PipelineLayout,
    extent: vk::Extent2D,
) -> Result<vk::Pipeline> {
    let vertex_spv = include_bytes!("../shaders/skeleton.vert.spv");
    let fragment_spv = include_bytes!("../shaders/skeleton.frag.spv");
    let vertex_module = shader_module(device, vertex_spv)?;
    let fragment_module = shader_module(device, fragment_spv)?;
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
        .stride(VERTEX_BYTES)
        .input_rate(vk::VertexInputRate::VERTEX)];
    let attributes = [
        vk::VertexInputAttributeDescription::default()
            .location(0)
            .format(vk::Format::R32G32B32_SFLOAT)
            .offset(0),
        vk::VertexInputAttributeDescription::default()
            .location(1)
            .format(vk::Format::R32G32B32_SFLOAT)
            .offset(12),
        vk::VertexInputAttributeDescription::default()
            .location(2)
            .format(vk::Format::R32_UINT)
            .offset(24),
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
    // No culling. A skeleton is full of thin shells and open ends, and a back face that vanishes
    // reads as a hole in the bone rather than as an optimisation.
    let raster = vk::PipelineRasterizationStateCreateInfo::default()
        .polygon_mode(vk::PolygonMode::FILL)
        .cull_mode(vk::CullModeFlags::NONE)
        .front_face(vk::FrontFace::COUNTER_CLOCKWISE)
        .line_width(1.0);
    let multisample = vk::PipelineMultisampleStateCreateInfo::default()
        .rasterization_samples(vk::SampleCountFlags::TYPE_1);
    let depth_stencil = vk::PipelineDepthStencilStateCreateInfo::default()
        .depth_test_enable(true)
        .depth_write_enable(true)
        .depth_compare_op(vk::CompareOp::LESS);
    let blend_attachments = [vk::PipelineColorBlendAttachmentState::default()
        .color_write_mask(vk::ColorComponentFlags::RGBA)];
    let blend =
        vk::PipelineColorBlendStateCreateInfo::default().attachments(&blend_attachments);

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
    .map_err(|(_, e)| e)
    .context("creating the graphics pipeline")?[0];
    unsafe {
        device.destroy_shader_module(vertex_module, None);
        device.destroy_shader_module(fragment_module, None);
    }
    Ok(pipeline)
}

fn shader_module(device: &ash::Device, spv: &[u8]) -> Result<vk::ShaderModule> {
    let words: Vec<u32> = spv
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    Ok(unsafe {
        device.create_shader_module(
            &vk::ShaderModuleCreateInfo::default().code(&words),
            None,
        )
    }?)
}

impl Buffer {
    fn new(
        device: &ash::Device,
        properties: &vk::PhysicalDeviceMemoryProperties,
        size: usize,
        usage: vk::BufferUsageFlags,
    ) -> Result<Self> {
        let handle = unsafe {
            device.create_buffer(
                &vk::BufferCreateInfo::default()
                    .size(size as u64)
                    .usage(usage)
                    .sharing_mode(vk::SharingMode::EXCLUSIVE),
                None,
            )
        }?;
        let needs = unsafe { device.get_buffer_memory_requirements(handle) };
        // Host visible and coherent throughout: every one of these is written by the CPU, the
        // largest is twelve megabytes, and a staging copy for that is machinery without a payoff.
        let memory = allocate(
            device,
            properties,
            needs,
            vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
        )?;
        unsafe { device.bind_buffer_memory(handle, memory, 0) }?;
        let mapped = unsafe {
            device.map_memory(memory, 0, vk::WHOLE_SIZE, vk::MemoryMapFlags::empty())
        }?;
        Ok(Self {
            handle,
            memory,
            mapped,
        })
    }

    fn write(&self, bytes: &[u8]) {
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.mapped as *mut u8, bytes.len());
        }
    }

    fn write_at(&self, offset: usize, bytes: &[u8]) {
        unsafe {
            std::ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                (self.mapped as *mut u8).add(offset),
                bytes.len(),
            );
        }
    }

    unsafe fn destroy(&self, device: &ash::Device) {
        unsafe {
            device.unmap_memory(self.memory);
            device.destroy_buffer(self.handle, None);
            device.free_memory(self.memory, None);
        }
    }
}

impl Image {
    fn depth(
        device: &ash::Device,
        properties: &vk::PhysicalDeviceMemoryProperties,
        extent: vk::Extent2D,
    ) -> Result<Self> {
        let handle = unsafe {
            device.create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(vk::Format::D32_SFLOAT)
                    .extent(extent.into_3d())
                    .mip_levels(1)
                    // Two layers, matching the colour swapchain: multiview writes an eye to each.
                    .array_layers(2)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(vk::ImageUsageFlags::DEPTH_STENCIL_ATTACHMENT)
                    .initial_layout(vk::ImageLayout::UNDEFINED),
                None,
            )
        }?;
        let needs = unsafe { device.get_image_memory_requirements(handle) };
        let memory = allocate(
            device,
            properties,
            needs,
            vk::MemoryPropertyFlags::DEVICE_LOCAL,
        )?;
        unsafe { device.bind_image_memory(handle, memory, 0) }?;
        let view = unsafe {
            device.create_image_view(
                &vk::ImageViewCreateInfo::default()
                    .image(handle)
                    .view_type(vk::ImageViewType::TYPE_2D_ARRAY)
                    .format(vk::Format::D32_SFLOAT)
                    .subresource_range(
                        vk::ImageSubresourceRange::default()
                            .aspect_mask(vk::ImageAspectFlags::DEPTH)
                            .level_count(1)
                            .layer_count(2),
                    ),
                None,
            )
        }?;
        Ok(Self {
            handle,
            memory,
            view,
        })
    }

    unsafe fn destroy(&self, device: &ash::Device) {
        unsafe {
            device.destroy_image_view(self.view, None);
            device.destroy_image(self.handle, None);
            device.free_memory(self.memory, None);
        }
    }
}

trait Extent3d {
    fn into_3d(self) -> vk::Extent3D;
}
impl Extent3d for vk::Extent2D {
    fn into_3d(self) -> vk::Extent3D {
        vk::Extent3D {
            width: self.width,
            height: self.height,
            depth: 1,
        }
    }
}

fn allocate(
    device: &ash::Device,
    properties: &vk::PhysicalDeviceMemoryProperties,
    needs: vk::MemoryRequirements,
    wanted: vk::MemoryPropertyFlags,
) -> Result<vk::DeviceMemory> {
    let index = (0..properties.memory_type_count)
        .find(|i| {
            needs.memory_type_bits & (1 << i) != 0
                && properties.memory_types[*i as usize]
                    .property_flags
                    .contains(wanted)
        })
        .context("no memory type on this device has the properties this allocation needs")?;
    Ok(unsafe {
        device.allocate_memory(
            &vk::MemoryAllocateInfo::default()
                .allocation_size(needs.size)
                .memory_type_index(index),
            None,
        )
    }?)
}

fn bytes_of<T>(slice: &[T]) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(slice.as_ptr() as *const u8, std::mem::size_of_val(slice))
    }
}

/// Where the body stands and which way it faces: the matrix every bone is placed by. The
/// simulation's ground is lifted to the stage's floor, so a scenario with a raised ground still
/// has the body standing on the grid.
pub(crate) fn placement(ground_height: f32) -> [f32; 16] {
    translation(STANDS_AT[0], STANDS_AT[1] - ground_height, STANDS_AT[2], true)
}

/// The inverse of the placement, for a point: where in the simulation's own frame a point in the
/// room is. Rotation by half a turn about Y is its own inverse, so this is subtract, then flip.
pub(crate) fn unplace(p: [f32; 3], ground_height: f32) -> [f32; 3] {
    [
        -(p[0] - STANDS_AT[0]),
        p[1] - (STANDS_AT[1] - ground_height),
        -(p[2] - STANDS_AT[2]),
    ]
}

/// A rotation in the room, in the simulation's frame: conjugated by the placement's half turn
/// about Y, which is its own inverse.
pub(crate) fn unplace_rotation(q: [f32; 4]) -> [f32; 4] {
    let half_turn = [0.0, 1.0, 0.0, 0.0];
    quaternion_multiply(quaternion_multiply(half_turn, q), quaternion_conjugate(half_turn))
}

/// `a` then `b`, as xyzw quaternions: the rotation `b` applied after `a`... which is to say the
/// product `a * b` in the convention where `q * v` turns `v` by `q`.
pub(crate) fn quaternion_multiply(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

pub(crate) fn quaternion_conjugate(q: [f32; 4]) -> [f32; 4] {
    [-q[0], -q[1], -q[2], q[3]]
}

/// A uniform scale, which is how a pack at one stature is drawn at another.
pub(crate) fn scale_matrix(s: f32) -> [f32; 16] {
    [
        s, 0.0, 0.0, 0.0, //
        0.0, s, 0.0, 0.0, //
        0.0, 0.0, s, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ]
}

/// A rigid transform from a position and a quaternion, column-major.
pub(crate) fn pose_matrix(p: [f32; 3], q: [f32; 4]) -> [f32; 16] {
    let r = rotation(q);
    [
        r[0], r[1], r[2], 0.0, //
        r[3], r[4], r[5], 0.0, //
        r[6], r[7], r[8], 0.0, //
        p[0], p[1], p[2], 1.0,
    ]
}

/// The inverse of that: rotation transposed, translation carried back through it.
pub(crate) fn inverse_pose(p: [f32; 3], q: [f32; 4]) -> [f32; 16] {
    let r = rotation(q);
    let t = [
        -(r[0] * p[0] + r[1] * p[1] + r[2] * p[2]),
        -(r[3] * p[0] + r[4] * p[1] + r[5] * p[2]),
        -(r[6] * p[0] + r[7] * p[1] + r[8] * p[2]),
    ];
    [
        r[0], r[3], r[6], 0.0, //
        r[1], r[4], r[7], 0.0, //
        r[2], r[5], r[8], 0.0, //
        t[0], t[1], t[2], 1.0,
    ]
}

/// A vector turned by a quaternion.
pub(crate) fn rotate(v: [f32; 3], q: [f32; 4]) -> [f32; 3] {
    let r = rotation(q);
    [
        r[0] * v[0] + r[3] * v[1] + r[6] * v[2],
        r[1] * v[0] + r[4] * v[1] + r[7] * v[2],
        r[2] * v[0] + r[5] * v[1] + r[8] * v[2],
    ]
}

/// A quaternion as a 3x3 rotation, column-major.
fn rotation(q: [f32; 4]) -> [f32; 9] {
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    [
        1.0 - 2.0 * (y * y + z * z),
        2.0 * (x * y + z * w),
        2.0 * (x * z - y * w),
        2.0 * (x * y - z * w),
        1.0 - 2.0 * (x * x + z * z),
        2.0 * (y * z + x * w),
        2.0 * (x * z + y * w),
        2.0 * (y * z - x * w),
        1.0 - 2.0 * (x * x + y * y),
    ]
}

/// A translation, optionally turned half a circle about Y so the body faces the viewer.
fn translation(x: f32, y: f32, z: f32, facing_viewer: bool) -> [f32; 16] {
    let s = if facing_viewer { -1.0 } else { 1.0 };
    // Column-major, as GLSL reads it.
    [
        s, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, s, 0.0, //
        x, y, z, 1.0,
    ]
}

/// The two view-projection matrices for this frame, column-major, as the shader expects them.
pub fn view_projections(views: &[openxr::View], near: f32, far: f32) -> [f32; 32] {
    let mut out = [0f32; 32];
    for (eye, view) in views.iter().take(2).enumerate() {
        let projection = projection_from_fov(view.fov, near, far);
        let view_matrix = inverse_rigid(view.pose);
        let product = multiply(&projection, &view_matrix);
        out[eye * 16..eye * 16 + 16].copy_from_slice(&product);
    }
    out
}

/// An asymmetric projection, which is what a headset's four half-angles describe.
///
/// Not a field of view and an aspect ratio: a lens is off-centre and its four angles differ, so
/// the frustum is built from the tangents directly. Reverse-Z is not used and depth compares LESS,
/// so this maps near to 0 and far to 1 the Vulkan way rather than the OpenGL way.
fn projection_from_fov(fov: openxr::Fovf, near: f32, far: f32) -> [f32; 16] {
    let left = fov.angle_left.tan();
    let right = fov.angle_right.tan();
    let up = fov.angle_up.tan();
    let down = fov.angle_down.tan();
    let width = right - left;
    let height = down - up; // Vulkan's Y points down the screen, so this is deliberately inverted.
    [
        2.0 / width, 0.0, 0.0, 0.0, //
        0.0, 2.0 / height, 0.0, 0.0, //
        (right + left) / width, (down + up) / height, -far / (far - near), -1.0, //
        0.0, 0.0, -(far * near) / (far - near), 0.0,
    ]
}

/// The inverse of a pose, which is the view matrix.
fn inverse_rigid(pose: openxr::Posef) -> [f32; 16] {
    inverse_pose(
        [pose.position.x, pose.position.y, pose.position.z],
        [pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w],
    )
}

pub(crate) fn multiply(a: &[f32; 16], b: &[f32; 16]) -> [f32; 16] {
    let mut out = [0f32; 16];
    for column in 0..4 {
        for row in 0..4 {
            let mut sum = 0.0;
            for k in 0..4 {
                sum += a[k * 4 + row] * b[column * 4 + k];
            }
            out[column * 4 + row] = sum;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fov and pose the Index actually reported, so these are this headset's numbers rather
    /// than plausible ones.
    fn left_eye() -> openxr::Fovf {
        openxr::Fovf {
            angle_left: -1.00,
            angle_right: 0.81,
            angle_up: 0.96,
            angle_down: -0.95,
        }
    }

    fn apply(m: &[f32; 16], v: [f32; 4]) -> [f32; 4] {
        let mut out = [0f32; 4];
        for row in 0..4 {
            for k in 0..4 {
                out[row] += m[k * 4 + row] * v[k];
            }
        }
        out
    }

    fn ndc(m: &[f32; 16], point: [f32; 3]) -> [f32; 3] {
        let clip = apply(m, [point[0], point[1], point[2], 1.0]);
        [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]]
    }

    #[test]
    fn depth_maps_near_to_zero_and_far_to_one() {
        // Vulkan's convention, and the one the pipeline's LESS compare assumes. Getting this
        // backwards is a depth test that keeps the furthest surface, which looks like a skeleton
        // turned inside out rather than like a depth bug.
        let p = projection_from_fov(left_eye(), 0.05, 50.0);
        let near = ndc(&p, [0.0, 0.0, -0.05]);
        let far = ndc(&p, [0.0, 0.0, -50.0]);
        assert!((near[2] - 0.0).abs() < 1e-4, "near mapped to {}", near[2]);
        assert!((far[2] - 1.0).abs() < 1e-4, "far mapped to {}", far[2]);
    }

    #[test]
    fn the_fov_edges_land_on_the_edges_of_the_screen() {
        // The check that an asymmetric frustum is being built from the four half-angles rather
        // than from a symmetric field of view: each edge of the reported fov has to arrive at
        // exactly the corresponding edge of clip space, and they are not symmetric.
        let fov = left_eye();
        let p = projection_from_fov(fov, 0.05, 50.0);
        let at = -1.0f32;
        let left = ndc(&p, [fov.angle_left.tan() * -at, 0.0, at]);
        let right = ndc(&p, [fov.angle_right.tan() * -at, 0.0, at]);
        let up = ndc(&p, [0.0, fov.angle_up.tan() * -at, at]);
        let down = ndc(&p, [0.0, fov.angle_down.tan() * -at, at]);
        assert!((left[0] + 1.0).abs() < 1e-4, "left edge at x={}", left[0]);
        assert!((right[0] - 1.0).abs() < 1e-4, "right edge at x={}", right[0]);
        // Vulkan's Y runs down the framebuffer, so "up" in the world is -1 in clip space. An
        // unflipped Y is a scene rendered upside down, which in a headset is unmistakable and
        // deeply unpleasant.
        assert!((up[1] + 1.0).abs() < 1e-4, "up edge at y={}", up[1]);
        assert!((down[1] - 1.0).abs() < 1e-4, "down edge at y={}", down[1]);
    }

    #[test]
    fn straight_ahead_is_off_centre_because_the_lens_is() {
        // Not a symmetry check but the opposite: this headset's left eye sees 1.00 rad to its
        // left and 0.81 to its right, so the view axis is genuinely right of the image centre.
        // A projection that put it at zero would be one built from a single field of view.
        let p = projection_from_fov(left_eye(), 0.05, 50.0);
        let ahead = ndc(&p, [0.0, 0.0, -1.0]);
        assert!(ahead[0] > 0.10 && ahead[0] < 0.30, "ahead at x={}", ahead[0]);
    }

    #[test]
    fn the_view_matrix_undoes_the_eye_pose() {
        // A rigid inverse, checked the only way worth checking it: the eye's own position has to
        // land at the origin of view space, and a point a metre in front of a turned head has to
        // arrive a metre down -Z however the head is turned.
        let angle = 0.7f32;
        let pose = openxr::Posef {
            orientation: openxr::Quaternionf {
                x: 0.0,
                y: (angle / 2.0).sin(),
                z: 0.0,
                w: (angle / 2.0).cos(),
            },
            position: openxr::Vector3f {
                x: 0.3,
                y: 1.6,
                z: -0.2,
            },
        };
        let view = inverse_rigid(pose);
        let eye = apply(&view, [0.3, 1.6, -0.2, 1.0]);
        for k in 0..3 {
            assert!(eye[k].abs() < 1e-5, "the eye did not land at the origin: {eye:?}");
        }
        // One metre along the direction the head is facing, which for a +Y rotation of `angle`
        // from -Z is (-sin, 0, -cos).
        let front = [
            0.3 - angle.sin(),
            1.6,
            -0.2 - angle.cos(),
        ];
        let seen = apply(&view, [front[0], front[1], front[2], 1.0]);
        assert!(seen[0].abs() < 1e-5 && seen[1].abs() < 1e-5, "not straight ahead: {seen:?}");
        assert!((seen[2] + 1.0).abs() < 1e-5, "not one metre away: {seen:?}");
    }

    #[test]
    fn a_ring_sweeps_into_a_circle_of_its_radius_with_radial_normals() {
        // One ring at the identity, centred at y = 1, radius 0.05, four segments: the vertices
        // are the four compass points of a circle in the XY plane, and each normal points out.
        let ring = [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.05];
        let mut out = Vec::new();
        tube_vertices(&ring, 4, 7, &mut out);
        assert_eq!(out.len(), 4 * 7);
        let v = |k: usize| &out[k * 7..k * 7 + 7];
        assert!((v(0)[0] - 0.05).abs() < 1e-6 && (v(0)[1] - 1.0).abs() < 1e-6);
        assert!((v(1)[1] - 1.05).abs() < 1e-6, "quarter turn is +Y: {:?}", v(1));
        assert!((v(2)[0] + 0.05).abs() < 1e-6);
        assert!((v(3)[1] - 0.95).abs() < 1e-6);
        assert!((v(1)[4] - 1.0).abs() < 1e-6, "normal of the +Y vertex is +Y");
        assert_eq!(v(0)[6].to_bits(), 7);
        // Two rings of four make one strip of four quads: 24 indices, none past the 8 vertices.
        let idx = tube_indices(1, 2, 4);
        assert_eq!(idx.len(), 24);
        assert!(idx.iter().all(|&i| i < 8));
        // Units are not stitched: the last index of unit 0 never reaches unit 1's vertices.
        let two = tube_indices(2, 2, 4);
        assert!(two[..24].iter().all(|&i| i < 8) && two[24..].iter().all(|&i| i >= 8));
    }

    #[test]
    fn unplace_takes_a_room_point_back_to_where_the_simulation_thinks_it_is() {
        let sim = [0.2, 1.1, 0.3];
        let room = apply(&placement(0.0), [sim[0], sim[1], sim[2], 1.0]);
        let back = unplace([room[0], room[1], room[2]], 0.0);
        for axis in 0..3 {
            assert!((back[axis] - sim[axis]).abs() < 1e-6, "axis {axis}: {back:?}");
        }
    }

    #[test]
    fn a_rotation_in_the_room_matches_the_same_rotation_of_a_placed_vector() {
        // Turn a vector by q in the room, take it into the simulation's frame; that must equal
        // taking the vector into the simulation's frame and turning it by unplace_rotation(q).
        // Only directions, so the ground and the standing spot fall out.
        let q: [f32; 4] = [0.2, 0.5, -0.1, 0.83]; // normalised just below
        let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        let q = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
        let v = [0.3, 0.1, 0.7];
        let flip = |p: [f32; 3]| [-p[0], p[1], -p[2]];
        let a = flip(rotate(v, q));
        let b = rotate(flip(v), unplace_rotation(q));
        for axis in 0..3 {
            assert!((a[axis] - b[axis]).abs() < 1e-5, "{a:?} vs {b:?}");
        }
        let id = quaternion_multiply(q, quaternion_conjugate(q));
        assert!((id[3] - 1.0).abs() < 1e-5 && id[0].abs() < 1e-5);
    }

    #[test]
    fn the_body_is_turned_to_face_the_viewer_without_being_mirrored() {
        // Half a turn about Y, which has determinant +1. A mirror would also put the front
        // towards the viewer and would swap the body's left and right, which on an anatomical
        // model is the kind of wrong that gets published before anybody notices.
        let m = translation(0.0, 0.0, -1.5, true);
        let determinant = m[0] * m[5] * m[10];
        assert!((determinant - 1.0).abs() < 1e-6, "determinant {determinant}");
        // Anterior is -Z in the pack, and after the turn it points back towards the viewer.
        let anterior = apply(&m, [0.0, 0.0, -1.0, 0.0]);
        assert!(anterior[2] > 0.99, "the body faces away: {anterior:?}");
        // And it stands a metre and a half out, feet still on the floor.
        let feet = apply(&m, [0.0, 0.0, 0.0, 1.0]);
        assert_eq!([feet[0], feet[1], feet[2]], [0.0, 0.0, -1.5]);
    }
}
