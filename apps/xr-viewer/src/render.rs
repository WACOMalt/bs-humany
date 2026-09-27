//! Drawing the body in the room into an OpenXR swapchain, both eyes in one pass.
//!
//! ## What is drawn
//!
//! **The bones**, skinned: one vertex buffer and one index buffer hold every bone of the pack,
//! each vertex carrying the index of the bone it belongs to, and a uniform array holds a
//! transform per bone. Posing the body is a write into that array -- one copy of it per
//! swapchain image, beside the eyes' view-projections -- rather than a draw call a bone or a
//! geometry rewrite, so the whole skeleton is still one draw.
//!
//! **Everything that is not a bone** is drawn through the same array, in the slots after the
//! bones that `Slots` names: a controller cube a hand, the world slot that places whatever is in
//! the simulation's frame, a pointer mark a hand, the floor grid, the scenery, and an aim ray a
//! hand. The cubes, marks, grid and rays are built into the bones' buffers once and moved by
//! their slots' matrices; the scenery is a pair of buffers of its own, rebuilt when the
//! scenario's boxes change.
//!
//! **The muscle tubes and the connective tissue** are swept on the CPU from the newest belly
//! rings and bone poses, and written each frame into a vertex buffer per swapchain image; their
//! connectivity depends only on counts and is built once. Their vertices carry colour codes
//! rather than bones -- a muscle's tension, a disc, a bead, a bar -- and are placed by the world
//! slot.
//!
//! **The egui panels**, the properties panel and the transport strip, come last on a pipeline of
//! their own over the same render pass: textured, blended, tested against the body's depth and
//! never writing it, each mesh cut to its clip rectangle.
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
//! Memory is allocated per resource, with no allocator: the resources are few and made once, or
//! once a scenario. Anything written every frame -- the view and bone uniforms, the muscle and
//! tissue vertices, the panels' meshes -- has a copy per swapchain image, because a buffer shared
//! between images would be written for one frame while the GPU still reads it for the last; the
//! depth image is the one thing shared, which the render pass's dependency makes safe. There is
//! no descriptor pool churn: one set an image for the uniforms, written once, and one a panel
//! texture. There is no MSAA, because the runtime asks for one sample. None of that is where the
//! time goes at half a million triangles.

use anyhow::{Context, Result, bail};
use ash::vk;
use std::ffi::CStr;

use crate::geometry::{flatten, posed_box, tube_indices};
use crate::math::placement;
use crate::pack::Pack;

const MAX_BONES: usize = 256;
/// Two transform slots past the last bone hold the tracked controllers, one a hand.
pub const CONTROLLERS: usize = 2;
/// After the controllers and the world slot, one slot a hand for the pointer's mark on the panel.
pub const MARKERS: usize = 2;
/// After the grid, the scenery: the scenario's static boxes, in the simulation's frame.
pub const SCENE_SLOTS: usize = 1;
/// After the scenery, one slot a hand for the aim ray: a thin box from the controller to where
/// it points.
pub const RAYS: usize = 2;

/// Where everything that is not a bone sits in the transform slots, worked out once from the
/// number of bones.
///
/// The bones take slots `0..bones`, and after them, in this order: a controller cube a hand, the
/// world slot, a pointer mark a hand, the stage (the grid), the scenery, and an aim ray a hand.
/// The order is not free. The shaders are handed the controller, world, stage and scene slots as
/// push constants and colour by them -- everything from the first controller up that is none of
/// the named slots is drawn in the controllers' blue, the marks and the rays included -- so a
/// new kind of slot goes on the end, where it moves nothing already there and needs no shader
/// rebuilt. Every place that needs a slot asks this rather than adding the counts up itself, as
/// the renderer's capacity check, its geometry and the frame loop each once did -- three sums that
/// had to agree, and a new kind of slot would have had to be added to all of them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slots {
    pub first_controller: usize,
    pub world: usize,
    pub first_marker: usize,
    pub stage: usize,
    pub scene: usize,
    pub first_ray: usize,
    /// How many slots there are altogether: one past the last.
    pub total: usize,
}

impl Slots {
    pub const fn for_bones(bones: usize) -> Self {
        let first_controller = bones;
        let world = first_controller + CONTROLLERS;
        let first_marker = world + 1;
        let stage = first_marker + MARKERS;
        let scene = stage + 1;
        let first_ray = scene + SCENE_SLOTS;
        Self {
            first_controller,
            world,
            first_marker,
            stage,
            scene,
            first_ray,
            total: first_ray + RAYS,
        }
    }

    /// The slot a controller's cube is drawn by; `hand` is 0 left, 1 right.
    pub const fn controller(&self, hand: usize) -> usize {
        self.first_controller + hand
    }

    /// The slot a hand's pointer mark is drawn by.
    pub const fn marker(&self, hand: usize) -> usize {
        self.first_marker + hand
    }

    /// The slot a hand's aim ray is drawn by.
    pub const fn ray(&self, hand: usize) -> usize {
        self.first_ray + hand
    }

    /// Whether a slot belongs to the hands -- a cube, a mark or a ray -- which live in the stage
    /// and are drawn where the runtime puts them, rather than in the world, which moves under
    /// the stage as the viewer walks and turns.
    pub const fn is_hand(&self, slot: usize) -> bool {
        (slot >= self.first_controller && slot < self.first_controller + CONTROLLERS)
            || (slot >= self.first_marker && slot < self.first_marker + MARKERS)
            || (slot >= self.first_ray && slot < self.first_ray + RAYS)
    }

    /// Whether the shader's uniform array holds every slot.
    pub const fn fits(&self) -> bool {
        self.total <= MAX_BONES
    }
}
/// How many egui vertices and indices a frame of the panel may have; more is cut off.
const PANEL_VERTICES: usize = 32768;
const PANEL_INDICES: usize = 98304;
/// Where a panel mesh's clip rectangle sits in the push constants: after the 64-byte matrix,
/// which is the `layout(offset = 64)` in `panel.frag`.
const PANEL_CLIP_OFFSET: u32 = 64;
/// Position, normal, bone index.
const VERTEX_BYTES: u32 = 3 * 4 + 3 * 4 + 4;

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
    /// Where everything that is not a bone sits in the transform slots.
    slots: Slots,
    memory_properties: vk::PhysicalDeviceMemoryProperties,
    /// The muscle tubes, once a bridge has said how many rings there are.
    muscles: Option<Muscles>,
    tissue: Option<Tissue>,
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
/// kilobytes is the whole cost of not having that bug. The depth image is the exception, one for
/// all of them: the render pass's external dependency is what makes one shared depth image safe
/// while frames overlap, chosen over a depth image per Target at about 36 MB each.
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

/// Slots from here up are colour codes, not bones: see `skeleton.vert`. Past every bone slot
/// the uniform holds, so a code is never mistaken for one.
pub const TINT_BASE: u32 = MAX_BONES as u32;
/// Codes: a muscle's tension in sixteenths, then the tissue kinds.
pub const TINT_STEPS: u32 = 16;
pub const CODE_DISC: u32 = 16;
pub const CODE_BEAD: u32 = 17;
pub const CODE_BAR: u32 = 18;

/// The connective tissue's buffers, the same shape as the muscles': connectivity fixed once,
/// vertices every frame.
struct Tissue {
    index: Buffer,
    index_count: u32,
    vertex_floats: usize,
    per_target: Vec<Buffer>,
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
    /// Whether this device can build egui's textures a mip chain: blit from and to the format and
    /// filter it linearly. Asked once at start-up; without it every texture is one level, as before.
    mipmapped: bool,
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
    /// Levels in the image's mip chain, level 0 the pixels egui gave.
    levels: u32,
    pixels: Vec<u8>,
}

/// The format of every egui texture: egui's colours are sRGB, and the sampler decodes them to
/// linear before it filters, as a blit between levels does.
const PANEL_TEXTURE_FORMAT: vk::Format = vk::Format::R8G8B8A8_SRGB;

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
fn can_mipmap(features: vk::FormatFeatureFlags) -> bool {
    features.contains(
        vk::FormatFeatureFlags::BLIT_SRC
            | vk::FormatFeatureFlags::BLIT_DST
            | vk::FormatFeatureFlags::SAMPLED_IMAGE_FILTER_LINEAR,
    )
}

/// The panel as `draw` wants it: the matrix that stands it up, and egui's meshes, each with the
/// rectangle it is cut to. Panels are drawn in the order given, and they neither write depth
/// nor test it against each other, so the caller puts the farther first.
pub struct PanelDraw<'a> {
    pub model: [f32; 16],
    pub meshes: &'a [crate::panel::Mesh],
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
        let slots = Slots::for_bones(pack.bones.len());
        if !slots.fits() {
            bail!(
                "the pack has {} bones, and with {CONTROLLERS} controller cubes, the world slot, \
                 {MARKERS} pointer marks, the grid, {SCENE_SLOTS} scenery slot and {RAYS} aim rays that \
                 is {} transform slots, where the shader holds {MAX_BONES}.",
                pack.bones.len(),
                slots.total
            );
        }
        let (vertices, indices) = flatten(pack, &slots);
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
            .stage_flags(vk::ShaderStageFlags::VERTEX | vk::ShaderStageFlags::FRAGMENT)
            .offset(0)
            .size(20)];
        let pipeline_layout = unsafe {
            device.create_pipeline_layout(
                &vk::PipelineLayoutCreateInfo::default()
                    .set_layouts(&[set_layout])
                    .push_constant_ranges(&push),
                None,
            )
        }?;
        let pipeline = build_pipeline(&device, render_pass, pipeline_layout, extent)?;
        let texture_features = unsafe {
            instance.get_physical_device_format_properties(physical, PANEL_TEXTURE_FORMAT)
        }
        .optimal_tiling_features;
        let panel = PanelGpu::new(
            &device,
            &memory_properties,
            render_pass,
            set_layout,
            extent,
            swapchain_images.len(),
            can_mipmap(texture_features),
        )?;

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
        // One image, not one a target, although frames overlap: the render pass's external
        // dependency (multiview_render_pass) orders each frame's clear after the last frame's
        // depth writes, which is what makes sharing it safe, and saves about 36 MB a target.
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
            slots,
            memory_properties,
            muscles: None,
            tissue: None,
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
        tissue: Option<&[f32]>,
        panels: &[PanelDraw],
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
                } else {
                    tubes.filled[image].set(false);
                }
            } else if let Some(tubes) = &self.muscles {
                tubes.filled[image].set(false);
            }
            if let (Some(set), Some(vertices)) = (&self.tissue, tissue) {
                if vertices.len() == set.vertex_floats {
                    set.per_target[image].write(bytes_of(vertices));
                    set.filled[image].set(true);
                } else {
                    set.filled[image].set(false);
                }
            } else if let Some(set) = &self.tissue {
                set.filled[image].set(false);
            }
            // The panels' meshes, packed end to end into this image's buffers, remembering where
            // each begins and which panel it belongs to, so it is drawn with its own texture
            // under its own placement.
            let mut panel_draws: Vec<(usize, u64, [f32; 4], u32, u32, i32)> = Vec::new();
            {
                let (vertex_buffer, index_buffer) = &self.panel.per_target[image];
                let mut vertex_at = 0usize;
                let mut index_at = 0usize;
                for (which, panel) in panels.iter().enumerate() {
                    for mesh in panel.meshes {
                        let key = texture_key(mesh.texture);
                        if !self.panel.textures.contains_key(&key)
                            || vertex_at + mesh.vertices.len() > PANEL_VERTICES
                            || index_at + mesh.indices.len() > PANEL_INDICES
                        {
                            continue;
                        }
                        vertex_buffer.write_at(vertex_at * 20, bytes_of(&mesh.vertices));
                        index_buffer.write_at(index_at * 4, bytes_of(&mesh.indices));
                        let clip = [mesh.clip.min.x, mesh.clip.min.y, mesh.clip.max.x, mesh.clip.max.y];
                        panel_draws.push((
                            which,
                            key,
                            clip,
                            index_at as u32,
                            mesh.indices.len() as u32,
                            vertex_at as i32,
                        ));
                        vertex_at += mesh.vertices.len();
                        index_at += mesh.indices.len();
                    }
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
                vk::ShaderStageFlags::VERTEX | vk::ShaderStageFlags::FRAGMENT,
                0,
                bytes_of(&[
                    self.slots.first_controller as u32,
                    self.slots.world as u32,
                    self.slots.stage as u32,
                    self.slots.scene as u32,
                    TINT_BASE,
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
            // The tissue, in the simulation's frame like the muscles, rebuilt each frame.
            if let Some(set) = &self.tissue {
                if set.filled[image].get() {
                    device.cmd_bind_vertex_buffers(
                        target.command_buffer,
                        0,
                        &[set.per_target[image].handle],
                        &[0],
                    );
                    device.cmd_bind_index_buffer(
                        target.command_buffer,
                        set.index.handle,
                        0,
                        vk::IndexType::UINT32,
                    );
                    device.cmd_draw_indexed(target.command_buffer, set.index_count, 1, 0, 0, 0);
                }
            }
            // The scenery, in the simulation's frame like the muscles.
            if let Some((vertex, index, count)) = &self.scene {
                device.cmd_bind_vertex_buffers(target.command_buffer, 0, &[vertex.handle], &[0]);
                device.cmd_bind_index_buffer(target.command_buffer, index.handle, 0, vk::IndexType::UINT32);
                device.cmd_draw_indexed(target.command_buffer, *count, 1, 0, 0, 0);
            }
            // And the panels, on their own pipeline: blended, textured, one draw a mesh, each
            // panel's meshes under its own placement.
            if !panel_draws.is_empty() {
                {
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
                    device.cmd_bind_vertex_buffers(target.command_buffer, 0, &[vertex_buffer.handle], &[0]);
                    device.cmd_bind_index_buffer(
                        target.command_buffer,
                        index_buffer.handle,
                        0,
                        vk::IndexType::UINT32,
                    );
                    let mut pushed: Option<usize> = None;
                    for (which, key, clip, first_index, count, vertex_offset) in &panel_draws {
                        if pushed != Some(*which) {
                            device.cmd_push_constants(
                                target.command_buffer,
                                self.panel.layout,
                                vk::ShaderStageFlags::VERTEX,
                                0,
                                bytes_of(&panels[*which].model),
                            );
                            pushed = Some(*which);
                        }
                        // Every mesh its own rectangle, which the fragment stage cuts to: a
                        // scrolled column's rows stop at the column's edge.
                        device.cmd_push_constants(
                            target.command_buffer,
                            self.panel.layout,
                            vk::ShaderStageFlags::FRAGMENT,
                            PANEL_CLIP_OFFSET,
                            bytes_of(clip),
                        );
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

    /// Where the controllers, the world, the marks, the grid, the scenery and the rays sit in the
    /// transform slots, for the frame loop to write their matrices.
    pub fn slots(&self) -> Slots {
        self.slots
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
            posed_box(self.slots.scene as u32, b, &mut vertices, &mut indices);
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
                    let (image, full_size, levels, full_pixels) =
                        (existing.image, existing.size, existing.levels, existing.pixels.clone());
                    self.upload_texture(image, full_size, levels, &full_pixels)?;
                }
                _ => {
                    if let Some(old) = self.panel.textures.remove(&key) {
                        unsafe {
                            let _ = self.device.queue_wait_idle(self.queue);
                            old.destroy(&self.device);
                        }
                    }
                    let texture = self.panel.create_texture(&self.device, &self.memory_properties, size, pixels)?;
                    self.upload_texture(texture.image, texture.size, texture.levels, &texture.pixels)?;
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

    /// Copy pixels into level 0 of an image through a staging buffer, build the rest of its mip
    /// chain from it on the GPU, and leave every level ready for the fragment shader.
    ///
    /// The whole image is uploaded each time, a patch included, so every level starts UNDEFINED:
    /// what was there before is replaced, not kept. Each level below the first is a linear blit of
    /// the one above, which must by then be written and in TRANSFER_SRC, so the barriers walk down
    /// the chain one level at a time; each source level goes to SHADER_READ_ONLY as soon as it has
    /// been read, and the last, which is never a source, at the end.
    fn upload_texture(&self, image: vk::Image, size: [usize; 2], levels: u32, pixels: &[u8]) -> Result<()> {
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
        let every_level = vk::ImageSubresourceRange::default()
            .aspect_mask(vk::ImageAspectFlags::COLOR)
            .level_count(levels)
            .layer_count(1);
        let one_level = |level: u32| {
            vk::ImageSubresourceRange::default()
                .aspect_mask(vk::ImageAspectFlags::COLOR)
                .base_mip_level(level)
                .level_count(1)
                .layer_count(1)
        };
        let layers = |level: u32| {
            vk::ImageSubresourceLayers::default()
                .aspect_mask(vk::ImageAspectFlags::COLOR)
                .mip_level(level)
                .layer_count(1)
        };
        // A level's width and height, never below one texel, as the far corner a blit takes.
        let corner = |level: u32| vk::Offset3D {
            x: ((size[0] as u32) >> level).max(1) as i32,
            y: ((size[1] as u32) >> level).max(1) as i32,
            z: 1,
        };
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
                    .subresource_range(every_level)],
            );
            device.cmd_copy_buffer_to_image(
                command,
                staging.handle,
                image,
                vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                &[vk::BufferImageCopy::default()
                    .image_subresource(layers(0))
                    .image_extent(vk::Extent3D {
                        width: size[0] as u32,
                        height: size[1] as u32,
                        depth: 1,
                    })],
            );
            for level in 1..levels {
                let source = level - 1;
                // The level above has been written, by the copy or by the last blit, and becomes
                // the source of this one.
                device.cmd_pipeline_barrier(
                    command,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::DependencyFlags::empty(),
                    &[],
                    &[],
                    &[vk::ImageMemoryBarrier::default()
                        .image(image)
                        .old_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
                        .new_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                        .src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
                        .dst_access_mask(vk::AccessFlags::TRANSFER_READ)
                        .subresource_range(one_level(source))],
                );
                device.cmd_blit_image(
                    command,
                    image,
                    vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
                    image,
                    vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                    &[vk::ImageBlit::default()
                        .src_subresource(layers(source))
                        .src_offsets([vk::Offset3D::default(), corner(source)])
                        .dst_subresource(layers(level))
                        .dst_offsets([vk::Offset3D::default(), corner(level)])],
                    vk::Filter::LINEAR,
                );
                // Read, and never written again: ready for the shader.
                device.cmd_pipeline_barrier(
                    command,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::PipelineStageFlags::FRAGMENT_SHADER,
                    vk::DependencyFlags::empty(),
                    &[],
                    &[],
                    &[vk::ImageMemoryBarrier::default()
                        .image(image)
                        .old_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                        .new_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)
                        .src_access_mask(vk::AccessFlags::TRANSFER_READ)
                        .dst_access_mask(vk::AccessFlags::SHADER_READ)
                        .subresource_range(one_level(source))],
                );
            }
            // The last level, written by the copy when there is only the one, else by the last blit.
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
                    .subresource_range(one_level(levels - 1))],
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

    /// Make room for the tissue: `indices` is its fixed connectivity over `vertex_floats / 7`
    /// vertices, whose positions come every frame through `draw`.
    pub fn enable_tissue(&mut self, indices: &[u32], vertex_floats: usize) -> Result<()> {
        if let Some(old) = self.tissue.take() {
            unsafe {
                let _ = self.device.device_wait_idle();
                old.index.destroy(&self.device);
                for buffer in &old.per_target {
                    buffer.destroy(&self.device);
                }
            }
        }
        if indices.is_empty() || vertex_floats == 0 {
            return Ok(());
        }
        let index = Buffer::new(
            &self.device,
            &self.memory_properties,
            std::mem::size_of_val(indices),
            vk::BufferUsageFlags::INDEX_BUFFER,
        )?;
        index.write(bytes_of(indices));
        let mut per_target = Vec::with_capacity(self.targets.len());
        for _ in &self.targets {
            per_target.push(Buffer::new(
                &self.device,
                &self.memory_properties,
                vertex_floats * 4,
                vk::BufferUsageFlags::VERTEX_BUFFER,
            )?);
        }
        self.tissue = Some(Tissue {
            index,
            index_count: indices.len() as u32,
            vertex_floats,
            per_target,
            filled: (0..self.targets.len()).map(|_| std::cell::Cell::new(false)).collect(),
        });
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
            if let Some(set) = &self.tissue {
                set.index.destroy(&self.device);
                for buffer in &set.per_target {
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
    fn create_texture(
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

    // Every frame draws into the one depth image, and frames overlap: frame N+1 is submitted
    // while frame N's fragment tests may still be running, and nothing else orders the two on
    // the GPU -- each frame's fence belongs to its own swapchain image. The dependency Vulkan
    // supplies when none is given waits on nothing (TOP_OF_PIPE, no access), so N+1's clear of
    // the depth image, which is a write at the early fragment tests, and its layout transition
    // could land while N is still writing depth at the late ones. This one makes them wait for
    // every earlier depth write, and makes the colour writes wait for the colour stage of the
    // work before. It is what makes one shared depth image safe while frames overlap, and was
    // chosen over a depth image per swapchain image (about 36 MB each at the resolution the
    // runtime asks for) because what it costs is only that overlap of one frame's depth work
    // with the next. Every pipeline here is built against this one render pass object, so adding
    // it changes no pipeline's compatibility.
    let fragment_tests_and_colour = vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT
        | vk::PipelineStageFlags::EARLY_FRAGMENT_TESTS
        | vk::PipelineStageFlags::LATE_FRAGMENT_TESTS;
    let dependencies = [vk::SubpassDependency::default()
        .src_subpass(vk::SUBPASS_EXTERNAL)
        .dst_subpass(0)
        .src_stage_mask(fragment_tests_and_colour)
        .dst_stage_mask(fragment_tests_and_colour)
        .src_access_mask(vk::AccessFlags::DEPTH_STENCIL_ATTACHMENT_WRITE)
        .dst_access_mask(
            vk::AccessFlags::COLOR_ATTACHMENT_WRITE
                | vk::AccessFlags::DEPTH_STENCIL_ATTACHMENT_READ
                | vk::AccessFlags::DEPTH_STENCIL_ATTACHMENT_WRITE,
        )];

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
                .dependencies(&dependencies)
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

    #[test]
    fn the_slots_after_the_bones_keep_the_places_they_had_and_the_rays_go_on_the_end() {
        // A body of 206 bones. The slots up to the scenery are pinned where they were before the
        // layout had a name -- the shaders colour by them -- and the rays come after.
        let slots = Slots::for_bones(206);
        assert_eq!((slots.controller(0), slots.controller(1)), (206, 207));
        assert_eq!(slots.world, 208);
        assert_eq!((slots.marker(0), slots.marker(1)), (209, 210));
        assert_eq!(slots.stage, 211);
        assert_eq!(slots.scene, 212);
        assert_eq!((slots.ray(0), slots.ray(1)), (213, 214));
        assert_eq!(slots.total, 215);
        assert!(slots.fits());

        // Every slot is its own, and all of them lie below the total.
        let named = [
            slots.controller(0),
            slots.controller(1),
            slots.world,
            slots.marker(0),
            slots.marker(1),
            slots.stage,
            slots.scene,
            slots.ray(0),
            slots.ray(1),
        ];
        let mut distinct = named.to_vec();
        distinct.sort_unstable();
        distinct.dedup();
        assert_eq!(distinct.len(), named.len());
        assert!(named.iter().all(|&s| s >= 206 && s < slots.total));
        assert_eq!(named.len(), slots.total - 206, "a slot past the bones that nothing names");

        // The hands' slots are the cubes, the marks and the rays, and nothing else: not a bone,
        // not the world, the grid or the scenery.
        let hands = [
            slots.controller(0),
            slots.controller(1),
            slots.marker(0),
            slots.marker(1),
            slots.ray(0),
            slots.ray(1),
        ];
        for slot in 0..MAX_BONES {
            assert_eq!(slots.is_hand(slot), hands.contains(&slot), "slot {slot}");
        }
    }

    #[test]
    fn a_body_with_too_many_bones_for_the_shader_does_not_fit() {
        // 256 slots in the uniform, nine past the bones: 247 bones is the most there is room for.
        assert!(Slots::for_bones(247).fits());
        assert!(!Slots::for_bones(248).fits());
    }

}
