//! The Vulkan the renderer and the panels' pipeline share: host-visible buffers mapped for their
//! whole life, the one depth image, a memory allocation by property flags, shader modules from
//! committed SPIR-V, and a slice seen as its bytes.
//!
//! Allocation is one `vkAllocateMemory` a resource, with no allocator in between: the viewer has
//! a few dozen resources, made at start-up, when a scenario changes or when egui's textures do,
//! and none in an ordinary frame.

use anyhow::{Context, Result};
use ash::vk;

pub(crate) struct Buffer {
    pub(crate) handle: vk::Buffer,
    memory: vk::DeviceMemory,
    mapped: *mut std::ffi::c_void,
}

pub(crate) struct Image {
    handle: vk::Image,
    memory: vk::DeviceMemory,
    pub(crate) view: vk::ImageView,
}

pub(crate) fn shader_module(device: &ash::Device, spv: &[u8]) -> Result<vk::ShaderModule> {
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
    pub(crate) fn new(
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

    pub(crate) fn write(&self, bytes: &[u8]) {
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.mapped as *mut u8, bytes.len());
        }
    }

    pub(crate) fn write_at(&self, offset: usize, bytes: &[u8]) {
        unsafe {
            std::ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                (self.mapped as *mut u8).add(offset),
                bytes.len(),
            );
        }
    }

    pub(crate) unsafe fn destroy(&self, device: &ash::Device) {
        unsafe {
            device.unmap_memory(self.memory);
            device.destroy_buffer(self.handle, None);
            device.free_memory(self.memory, None);
        }
    }
}

impl Image {
    pub(crate) fn depth(
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

    pub(crate) unsafe fn destroy(&self, device: &ash::Device) {
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

pub(crate) fn allocate(
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

pub(crate) fn bytes_of<T>(slice: &[T]) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(slice.as_ptr() as *const u8, std::mem::size_of_val(slice))
    }
}
