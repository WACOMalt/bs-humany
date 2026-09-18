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
        if pack.bones.len() > MAX_BONES {
            bail!(
                "the pack has {} bones and the shader holds {MAX_BONES} transforms.",
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
        let placed = placement();
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
        let pipeline_layout = unsafe {
            device.create_pipeline_layout(
                &vk::PipelineLayoutCreateInfo::default().set_layouts(&[set_layout]),
                None,
            )
        }?;
        let pipeline = build_pipeline(&device, render_pass, pipeline_layout, extent)?;

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
            depth,
            targets,
            extent,
        })
    }

    /// Record and submit one frame into the given swapchain image.
    ///
    /// `bones` is one matrix per pack bone, or `None` to leave whatever this image's buffer last
    /// held -- which is the placement, for a viewer that is not following anything.
    pub fn draw(
        &self,
        image: usize,
        view_projections: &[f32; 32],
        bones: Option<&[[f32; 16]]>,
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
            device.cmd_bind_vertex_buffers(target.command_buffer, 0, &[self.vertex.handle], &[0]);
            device.cmd_bind_index_buffer(
                target.command_buffer,
                self.index.handle,
                0,
                vk::IndexType::UINT32,
            );
            // Every bone, both eyes, one call.
            device.cmd_draw_indexed(target.command_buffer, self.index_count, 1, 0, 0, 0);
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
        }
    }
}

/// Every bone's vertices and indices in one pair of buffers, indices rebased as they are copied.
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
    (vertices, indices)
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

/// Where the body stands and which way it faces: the matrix every bone is placed by.
pub(crate) fn placement() -> [f32; 16] {
    translation(STANDS_AT[0], STANDS_AT[1], STANDS_AT[2], true)
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
