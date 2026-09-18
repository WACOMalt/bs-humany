//! Bringing up OpenXR far enough to know whether this machine will cooperate.
//!
//! This is the half of the spike that cannot be checked without a headset, so it is arranged to
//! fail in useful places rather than in one lump at the end. Three steps, each reporting what it
//! found before the next is attempted:
//!
//!   1. **Instance.** Does a loader exist, which runtime answers, what extensions does it offer?
//!      Needs no hardware. Runs on a machine with nothing plugged in.
//!   2. **System and views.** Is there a head-mounted display, and what does it want rendered --
//!      how many views, at what resolution, at what rates? Needs the runtime to see a headset.
//!   3. **Session and frame loop.** Begin a session, wait on frames, read the predicted display
//!      time and the view poses. Submits *no layers*, which `xrEndFrame` permits, so this proves
//!      the timing and tracking path without a single line of Vulkan rendering in it.
//!
//! Step 3 still needs a Vulkan device, because OpenXR will only create a session against a
//! graphics binding and will only accept an instance and device built to its requirements. That
//! is exactly why this crate uses `ash` rather than a portability layer: the requirements come
//! from the runtime and have to be obeyed literally.
//!
//! What is deliberately not here is drawing. Getting a pipeline, a render pass and multiview
//! correct is ordinary graphics work; finding out that a runtime will not start a session is not,
//! and it is the thing worth learning first.

use anyhow::{Context, Result, bail};
use ash::vk::{self, Handle};
use std::ffi::{CStr, CString};

/// What the loader and runtime say before any hardware is involved.
pub fn probe() -> Result<()> {
    let entry = unsafe { openxr::Entry::load(&()) }
        .context("opening libopenxr_loader.so.1 -- install an OpenXR runtime (SteamVR, Monado)")?;
    let available = entry
        .enumerate_extensions()
        .context("asking the OpenXR loader which extensions it has")?;
    println!("OpenXR loader: found");
    println!(
        "  KHR_vulkan_enable2: {}   KHR_vulkan_enable: {}",
        available.khr_vulkan_enable2, available.khr_vulkan_enable
    );
    for layer in entry.enumerate_layers().unwrap_or_default() {
        println!("  layer: {}", layer.layer_name);
    }
    if !available.khr_vulkan_enable2 && !available.khr_vulkan_enable {
        bail!("the runtime offers no Vulkan binding, so nothing here can render to it.");
    }

    let mut wanted = openxr::ExtensionSet::default();
    wanted.khr_vulkan_enable2 = available.khr_vulkan_enable2;
    wanted.khr_vulkan_enable = !available.khr_vulkan_enable2 && available.khr_vulkan_enable;
    let instance = entry
        .create_instance(
            &openxr::ApplicationInfo {
                application_name: "bs-humany xr viewer",
                application_version: 1,
                engine_name: "bs-humany",
                engine_version: 1,
                api_version: openxr::Version::new(1, 0, 0),
            },
            &wanted,
            &[],
            &(),
        )
        .context("creating the OpenXR instance -- is a runtime installed and active?")?;

    let properties = instance.properties()?;
    println!(
        "runtime: {} {}",
        properties.runtime_name, properties.runtime_version
    );

    // From here on a headset has to exist. This is the line that tells somebody with nothing
    // plugged in that nothing is plugged in, rather than failing later and vaguely.
    let system = match instance.system(openxr::FormFactor::HEAD_MOUNTED_DISPLAY) {
        Ok(system) => system,
        Err(openxr::sys::Result::ERROR_FORM_FACTOR_UNAVAILABLE) => {
            println!("system: no head-mounted display available to this runtime right now.");
            println!("        (The loader and runtime are fine; there is no headset to ask.)");
            return Ok(());
        }
        Err(e) => return Err(e).context("asking for a head-mounted display"),
    };

    let system_properties = instance.system_properties(system)?;
    println!(
        "system: {} (vendor {})",
        system_properties.system_name, system_properties.vendor_id
    );

    let views =
        instance.enumerate_view_configuration_views(system, openxr::ViewConfigurationType::PRIMARY_STEREO)?;
    for (eye, view) in views.iter().enumerate() {
        println!(
            "  view {eye}: {}x{} recommended, {}x{} max, {} samples",
            view.recommended_image_rect_width,
            view.recommended_image_rect_height,
            view.max_image_rect_width,
            view.max_image_rect_height,
            view.recommended_swapchain_sample_count
        );
    }
    for rate in instance
        .enumerate_environment_blend_modes(system, openxr::ViewConfigurationType::PRIMARY_STEREO)?
    {
        println!("  blend mode: {rate:?}");
    }

    let requirements = instance.graphics_requirements::<openxr::Vulkan>(system)?;
    println!(
        "  wants Vulkan {}.{} to {}.{}",
        requirements.min_api_version_supported.major(),
        requirements.min_api_version_supported.minor(),
        requirements.max_api_version_supported.major(),
        requirements.max_api_version_supported.minor(),
    );
    Ok(())
}

/// A Vulkan instance and device built the way the runtime insists, and nothing more.
pub struct Graphics {
    /// Held so the loaded Vulkan library outlives everything created from it.
    #[allow(dead_code)]
    pub entry: ash::Entry,
    pub instance: ash::Instance,
    pub physical: vk::PhysicalDevice,
    pub device: ash::Device,
    pub queue_family: u32,
}

impl Graphics {
    /// Build Vulkan to the runtime's requirements.
    ///
    /// The order matters and is the runtime's, not ours: it names the instance extensions, it
    /// picks the physical device, and it names the device extensions. Choosing any of those
    /// ourselves is how a session creation ends in `ERROR_GRAPHICS_DEVICE_INVALID`.
    pub fn for_runtime(
        xr: &openxr::Instance,
        system: openxr::SystemId,
    ) -> Result<Self> {
        let requirements = xr.graphics_requirements::<openxr::Vulkan>(system)?;
        let entry = unsafe { ash::Entry::load() }.context("loading libvulkan")?;

        let api_version = vk::make_api_version(
            0,
            requirements.min_api_version_supported.major() as u32,
            requirements.min_api_version_supported.minor() as u32,
            0,
        );
        let name = CString::new("bs-humany xr viewer")?;
        let app = vk::ApplicationInfo::default()
            .application_name(&name)
            .application_version(1)
            .engine_name(&name)
            .engine_version(1)
            .api_version(api_version.max(vk::API_VERSION_1_1));

        let create = vk::InstanceCreateInfo::default().application_info(&app);
        let instance_handle = unsafe {
            xr.create_vulkan_instance(
                system,
                std::mem::transmute::<vk::PFN_vkGetInstanceProcAddr, _>(
                    entry.static_fn().get_instance_proc_addr,
                ),
                &create as *const _ as *const _,
            )
        }
        .context("the runtime refused to create a Vulkan instance")?
        .map_err(vk::Result::from_raw)
        .context("vkCreateInstance, through the runtime")?;
        let instance = unsafe {
            ash::Instance::load(
                entry.static_fn(),
                vk::Instance::from_raw(instance_handle as _),
            )
        };

        let physical = vk::PhysicalDevice::from_raw(unsafe {
            xr.vulkan_graphics_device(system, instance.handle().as_raw() as _)
        }? as _);

        let families = unsafe { instance.get_physical_device_queue_family_properties(physical) };
        let queue_family = families
            .iter()
            .enumerate()
            .find(|(_, f)| f.queue_flags.contains(vk::QueueFlags::GRAPHICS))
            .map(|(i, _)| i as u32)
            .context("no graphics queue on the device the runtime chose")?;

        let priorities = [1.0f32];
        let queues = [vk::DeviceQueueCreateInfo::default()
            .queue_family_index(queue_family)
            .queue_priorities(&priorities)];
        // Multiview is what makes stereo affordable: one pass, both eyes, rather than everything
        // drawn twice. Asked for here so a later renderer can rely on it.
        let mut multiview =
            vk::PhysicalDeviceMultiviewFeatures::default().multiview(true);
        let device_create = vk::DeviceCreateInfo::default()
            .queue_create_infos(&queues)
            .push_next(&mut multiview);
        let device_handle = unsafe {
            xr.create_vulkan_device(
                system,
                std::mem::transmute::<vk::PFN_vkGetInstanceProcAddr, _>(
                    entry.static_fn().get_instance_proc_addr,
                ),
                physical.as_raw() as _,
                &device_create as *const _ as *const _,
            )
        }
        .context("the runtime refused to create a Vulkan device")?
        .map_err(vk::Result::from_raw)
        .context("vkCreateDevice, through the runtime")?;
        let device = unsafe {
            ash::Device::load(instance.fp_v1_0(), vk::Device::from_raw(device_handle as _))
        };

        let properties = unsafe { instance.get_physical_device_properties(physical) };
        let device_name = unsafe { CStr::from_ptr(properties.device_name.as_ptr()) };
        println!("vulkan: {} on queue family {queue_family}", device_name.to_string_lossy());
        Ok(Self {
            entry,
            instance,
            physical,
            device,
            queue_family,
        })
    }
}

/// Begin a session, build the renderer and draw the skeleton until told to stop.
///
/// The frame loop takes the head pose the runtime predicts for *this* frame and draws from the
/// pose buffer as it stands, never waiting for anything upstream -- ADR-012. While the body is a
/// rest pose that distinction is invisible; it is the shape the loop has to have before a
/// simulation is attached to it, and retrofitting it afterwards is how a headset ends up stalling
/// on a slow tick.
pub fn view(pack: &crate::pack::Pack, seconds: f32, follow: Option<&std::path::Path>) -> Result<()> {
    let entry = unsafe { openxr::Entry::load(&()) }
        .context("opening libopenxr_loader.so.1 -- install an OpenXR runtime (SteamVR, Monado)")?;
    let available = entry.enumerate_extensions()?;
    let mut wanted = openxr::ExtensionSet::default();
    wanted.khr_vulkan_enable2 = available.khr_vulkan_enable2;
    let xr = entry.create_instance(
        &openxr::ApplicationInfo {
            application_name: "bs-humany xr viewer",
            application_version: 1,
            engine_name: "bs-humany",
            engine_version: 1,
            api_version: openxr::Version::new(1, 0, 0),
        },
        &wanted,
        &[],
        &(),
    )?;
    let system = xr.system(openxr::FormFactor::HEAD_MOUNTED_DISPLAY)?;
    let graphics = Graphics::for_runtime(&xr, system)?;

    let configs = xr.enumerate_view_configuration_views(
        system,
        openxr::ViewConfigurationType::PRIMARY_STEREO,
    )?;
    let extent = ash::vk::Extent2D {
        width: configs[0].recommended_image_rect_width,
        height: configs[0].recommended_image_rect_height,
    };

    let (session, mut frame_wait, mut frame_stream) = unsafe {
        xr.create_session::<openxr::Vulkan>(
            system,
            &openxr::vulkan::SessionCreateInfo {
                instance: graphics.instance.handle().as_raw() as _,
                physical_device: graphics.physical.as_raw() as _,
                device: graphics.device.handle().as_raw() as _,
                queue_family_index: graphics.queue_family,
                queue_index: 0,
            },
        )
    }?;

    // The runtime's preferred format, filtered to the ones this pipeline writes. Taking its first
    // choice is what keeps the compositor from converting every frame.
    let offered = session.enumerate_swapchain_formats()?;
    let format = offered
        .iter()
        .copied()
        .find(|f| {
            *f == ash::vk::Format::R8G8B8A8_SRGB.as_raw() as u32
                || *f == ash::vk::Format::B8G8R8A8_SRGB.as_raw() as u32
        })
        .map(|f| ash::vk::Format::from_raw(f as i32))
        .context("the runtime offered no 8-bit sRGB swapchain format")?;
    println!("swapchain: {}x{}, format {format:?}, 2 layers", extent.width, extent.height);

    let mut swapchain = session.create_swapchain(&openxr::SwapchainCreateInfo {
        create_flags: openxr::SwapchainCreateFlags::EMPTY,
        usage_flags: openxr::SwapchainUsageFlags::COLOR_ATTACHMENT
            | openxr::SwapchainUsageFlags::SAMPLED,
        format: format.as_raw() as u32,
        sample_count: 1,
        width: extent.width,
        height: extent.height,
        face_count: 1,
        // Two, one an eye: this is what makes the swapchain a multiview target.
        array_size: 2,
        mip_count: 1,
    })?;
    let images: Vec<ash::vk::Image> = swapchain
        .enumerate_images()?
        .into_iter()
        .map(|i| ash::vk::Image::from_raw(i))
        .collect();

    // The hands. One action set: where each grip is, and whether it is squeezing. Bound for the
    // Index controller this was built against and for the simple profile every runtime knows, so
    // a headset with some other controller still gets a trigger that grabs.
    let hands = Hands::new(&xr, &session)?;

    let mut renderer = crate::render::Renderer::new(
        &graphics.instance,
        graphics.physical,
        graphics.device.clone(),
        graphics.queue_family,
        format,
        extent,
        &images,
        pack,
    )?;
    println!(
        "renderer: {} bones, {} triangles, one draw a frame for both eyes",
        pack.bones.len(),
        pack.triangle_count()
    );

    // Following a simulation: the bridge, and which pack bone each of its bones is. Matched by
    // name once, because the pack and the pose are in different orders and the pose may carry
    // bones the pack has no mesh for.
    let mut bridge = match follow {
        Some(path) => Some(crate::bridge::PoseBridge::open(path)?),
        None => None,
    };
    let pose_index: Vec<Option<usize>> = pack
        .bones
        .iter()
        .map(|bone| bridge.as_ref().and_then(|b| b.names.iter().position(|n| *n == bone.id)))
        .collect();
    if let Some(b) = &bridge {
        let matched = pose_index.iter().filter(|m| m.is_some()).count();
        println!(
            "following {}: {} of {} pack bones have a pose, dataset scale {:.4}",
            follow.map(|p| p.display().to_string()).unwrap_or_default(),
            matched,
            pack.bones.len(),
            b.dataset_scale
        );
    }
    let place = crate::render::placement();
    // Bones, the two controllers, and the world slot, which stays at the placement.
    let mut matrices: Vec<[f32; 16]> =
        vec![place; pack.bones.len() + crate::render::CONTROLLERS + 1];
    let mut last_tick: Option<u64> = None;

    // The muscles, if the simulation has them: rings in their own bridge beside the poses, swept
    // into tubes here every time a new frame arrives. A publisher with muscles off writes no such
    // file, which is not an error.
    let mut muscles = match follow {
        Some(path) => {
            let muscle_path = std::path::PathBuf::from(format!("{}-muscles", path.display()));
            match crate::bridge::MuscleBridge::open(&muscle_path) {
                Ok(m) => {
                    println!(
                        "muscles: {} bellies of {} rings, {} segments round",
                        m.units, m.rings, m.segments
                    );
                    renderer.enable_muscles(m.units, m.rings, m.segments)?;
                    Some(m)
                }
                Err(_) => {
                    println!("muscles: none published");
                    None
                }
            }
        }
        None => None,
    };
    let mut muscle_vertices: Vec<f32> = Vec::new();
    let mut last_muscle_tick: Option<u64> = None;

    // Grabbing, when there is a simulation to grab. Intents go back beside the pose bridge; the
    // publisher looks for them there. What is held is remembered here so a hand that keeps
    // squeezing keeps the same bone, and a hand that opens sends one last inactive intent.
    let mut grabs = match follow {
        Some(path) => Some(crate::bridge::GrabIntentWriter::create(&std::path::PathBuf::from(
            format!("{}-grab", path.display()),
        ))?),
        None => None,
    };
    let mut holding: [Option<Hold>; crate::bridge::HANDS] = [None, None];
    let mut hand_seen = [false; crate::bridge::HANDS];
    let controller_scale = crate::render::scale_matrix(1.0);

    let stage =
        session.create_reference_space(openxr::ReferenceSpaceType::STAGE, openxr::Posef::IDENTITY)?;
    let mut event_storage = openxr::EventDataBuffer::new();
    let mut running = false;
    let mut frames = 0u32;
    let mut worst_cpu = 0f64;
    let started = std::time::Instant::now();
    // Reported as it goes rather than only at the end, because the natural way to stop watching
    // something in a headset is to take it off and press Ctrl-C, and a summary that only prints
    // on a clean exit is a summary nobody ever sees.
    let mut window_started = started;
    let mut window_frames = 0u32;
    let mut window_worst = 0f64;

    while started.elapsed().as_secs_f32() < seconds {
        while let Some(event) = xr.poll_event(&mut event_storage)? {
            use openxr::Event::*;
            if let SessionStateChanged(e) = event {
                println!("session: {:?}", e.state());
                match e.state() {
                    openxr::SessionState::READY => {
                        session.begin(openxr::ViewConfigurationType::PRIMARY_STEREO)?;
                        running = true;
                    }
                    openxr::SessionState::STOPPING => {
                        session.end()?;
                        running = false;
                    }
                    openxr::SessionState::EXITING | openxr::SessionState::LOSS_PENDING => {
                        renderer.wait_idle();
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }
        if !running {
            std::thread::sleep(std::time::Duration::from_millis(50));
            continue;
        }

        let state = frame_wait.wait()?;
        frame_stream.begin()?;
        if !state.should_render {
            frame_stream.end(
                state.predicted_display_time,
                openxr::EnvironmentBlendMode::OPAQUE,
                &[],
            )?;
            continue;
        }

        let cpu_started = std::time::Instant::now();
        let (_flags, views) = session.locate_views(
            openxr::ViewConfigurationType::PRIMARY_STEREO,
            state.predicted_display_time,
            &stage,
        )?;
        // The newest pose, if there is one and it is newer than the one already applied. Per
        // ADR-012 this never waits: no frame yet, or one mid-write, means the matrices stand.
        if let Some(b) = bridge.as_mut() {
            if let Some(frame) = b.newest() {
                if last_tick != Some(frame.tick) {
                    last_tick = Some(frame.tick);
                    let scale = crate::render::scale_matrix(b.dataset_scale as f32);
                    for (i, found) in pose_index.iter().enumerate() {
                        matrices[i] = match found {
                            Some(j) => {
                                let p = &frame.pose[j * 7..j * 7 + 7];
                                let r = &b.rest[j * 7..j * 7 + 7];
                                // place * current * rest^-1 * scale: the studio's own skin, with
                                // the pack scaled to this body's stature on the way in.
                                let current =
                                    crate::render::pose_matrix([p[0], p[1], p[2]], [p[3], p[4], p[5], p[6]]);
                                let rest_inverse =
                                    crate::render::inverse_pose([r[0], r[1], r[2]], [r[3], r[4], r[5], r[6]]);
                                crate::render::multiply(
                                    &place,
                                    &crate::render::multiply(
                                        &current,
                                        &crate::render::multiply(&rest_inverse, &scale),
                                    ),
                                )
                            }
                            None => place,
                        };
                    }
                }
            }
        }
        // The hands: located in the stage like the eyes, drawn as cubes at their grips, and asked
        // whether they are squeezing. A hand the runtime cannot place this frame keeps its last
        // cube and cannot begin a grab, but a grab already begun continues at the last target.
        hands.sync(&session)?;
        for hand in 0..crate::bridge::HANDS {
            let slot = renderer.controller_slot(hand);
            let located = hands.locate(hand, &stage, state.predicted_display_time)?;
            if let Some((position, orientation)) = located {
                if !hand_seen[hand] {
                    hand_seen[hand] = true;
                    println!("hand {}: tracked", ["left", "right"][hand]);
                }
                matrices[slot] = crate::render::multiply(
                    &crate::render::pose_matrix(position, orientation),
                    &controller_scale,
                );
            }
            let Some(writer) = grabs.as_mut() else { continue };
            let squeezing = hands.squeezing(&session, hand)?;
            let in_sim = located.map(|(p, _)| crate::render::unplace(p));
            let intent = match (&holding[hand], squeezing, in_sim) {
                (None, true, Some(at)) => {
                    // A grab begins: the bone whose posed extent the hand is nearest to, if any
                    // is within reach. Nothing in reach is a squeeze in empty air, which sends
                    // nothing and holds nothing.
                    let b = bridge.as_ref().expect("grabs exist only when following");
                    match nearest_bone(pack, &matrices, &pose_index, b.dataset_scale as f32, located.unwrap().0) {
                        Some((pack_bone, pose_bone)) => {
                            println!(
                                "hand {}: grabbed {}",
                                ["left", "right"][hand],
                                pack.bones[pack_bone].id
                            );
                            holding[hand] = Some(Hold { pose_bone, point: at });
                            crate::bridge::GrabIntent {
                                active: true,
                                bone: pose_bone as i32,
                                point: at,
                                target: at,
                                strength: 1.0,
                            }
                        }
                        None => crate::bridge::GrabIntent::default(),
                    }
                }
                (Some(hold), true, at) => crate::bridge::GrabIntent {
                    active: true,
                    bone: hold.pose_bone as i32,
                    point: hold.point,
                    target: at.unwrap_or(hold.point),
                    strength: 1.0,
                },
                (Some(_), false, _) => {
                    println!("hand {}: let go", ["left", "right"][hand]);
                    holding[hand] = None;
                    crate::bridge::GrabIntent::default()
                }
                _ => crate::bridge::GrabIntent::default(),
            };
            writer.publish(hand, &intent);
        }

        if let Some(m) = muscles.as_mut() {
            if let Some(frame) = m.newest() {
                if last_muscle_tick != Some(frame.tick) {
                    last_muscle_tick = Some(frame.tick);
                    crate::render::tube_vertices(
                        &frame.rings,
                        m.segments,
                        renderer.world_slot() as u32,
                        &mut muscle_vertices,
                    );
                }
            }
        }
        let image = swapchain.acquire_image()?;
        swapchain.wait_image(openxr::Duration::INFINITE)?;
        renderer.draw(
            image as usize,
            &crate::render::view_projections(&views, 0.05, 50.0),
            Some(matrices.as_slice()),
            if muscle_vertices.is_empty() { None } else { Some(muscle_vertices.as_slice()) },
        )?;
        swapchain.release_image()?;
        let cpu_ms = cpu_started.elapsed().as_secs_f64() * 1000.0;
        worst_cpu = worst_cpu.max(cpu_ms);
        window_worst = window_worst.max(cpu_ms);

        let rect = openxr::Rect2Di {
            offset: openxr::Offset2Di { x: 0, y: 0 },
            extent: openxr::Extent2Di {
                width: extent.width as i32,
                height: extent.height as i32,
            },
        };
        let eyes: Vec<_> = (0..2)
            .map(|eye| {
                openxr::CompositionLayerProjectionView::new()
                    .pose(views[eye].pose)
                    .fov(views[eye].fov)
                    .sub_image(
                        openxr::SwapchainSubImage::new()
                            .swapchain(&swapchain)
                            .image_array_index(eye as u32)
                            .image_rect(rect),
                    )
            })
            .collect();
        frame_stream.end(
            state.predicted_display_time,
            openxr::EnvironmentBlendMode::OPAQUE,
            &[&openxr::CompositionLayerProjection::new()
                .space(&stage)
                .views(&eyes)],
        )?;
        frames += 1;
        window_frames += 1;
        let window = window_started.elapsed().as_secs_f64();
        if window >= 2.0 {
            let pose_age = bridge
                .as_ref()
                .map(|b| format!(", pose {:.0} ms old", b.stale_for().as_secs_f64() * 1000.0))
                .unwrap_or_default();
            let held = holding
                .iter()
                .flatten()
                .map(|h| bridge.as_ref().map(|b| b.names[h.pose_bone].clone()).unwrap_or_default())
                .collect::<Vec<_>>()
                .join(" and ");
            let held = if held.is_empty() { held } else { format!(", holding {held}") };
            let bellies = muscles
                .as_ref()
                .map(|m| format!(", {} muscle frames", m.published()))
                .unwrap_or_default();
            println!(
                "  {:.1} Hz, worst CPU frame {window_worst:.2} ms{pose_age}{bellies}{held}",
                window_frames as f64 / window
            );
            window_started = std::time::Instant::now();
            window_frames = 0;
            window_worst = 0.0;
        }
    }

    renderer.wait_idle();
    println!(
        "{frames} frames in {:.1} s -- {:.1} Hz, worst CPU frame {worst_cpu:.2} ms",
        started.elapsed().as_secs_f32(),
        frames as f32 / started.elapsed().as_secs_f32()
    );
    Ok(())
}

/// What a hand is holding: which pose bone, and where in the simulation's frame it took hold.
struct Hold {
    pose_bone: usize,
    point: [f32; 3],
}

/// The bone nearest a hand in the room, if the hand is within reach of it.
///
/// Reach is judged against each bone's posed extent: its centroid carried by its current matrix,
/// and half its bounding diagonal at the body's scale, plus a margin about the width of a
/// controller. Of the bones the hand is inside, the one whose surface is nearest wins. Bones
/// with no pose cannot be grabbed, since there is nothing behind them to pull.
fn nearest_bone(
    pack: &crate::pack::Pack,
    matrices: &[[f32; 16]],
    pose_index: &[Option<usize>],
    dataset_scale: f32,
    hand: [f32; 3],
) -> Option<(usize, usize)> {
    const REACH: f32 = 0.04;
    let mut best: Option<(f32, usize, usize)> = None;
    for (i, packed) in pack.manifest.bones.iter().enumerate() {
        let Some(pose_bone) = pose_index.get(i).copied().flatten() else { continue };
        let m = &matrices[i];
        let c = packed.centroid.map(|v| v as f32);
        let centre = [
            m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12],
            m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13],
            m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14],
        ];
        let extent = (0..3)
            .map(|a| (packed.max[a] - packed.min[a]) as f32)
            .fold(0.0f32, |acc, e| acc + e * e)
            .sqrt();
        let radius = extent / 2.0 * dataset_scale;
        let distance = (0..3)
            .map(|a| hand[a] - centre[a])
            .fold(0.0f32, |acc, d| acc + d * d)
            .sqrt();
        let outside = distance - radius;
        if outside > REACH {
            continue;
        }
        if best.map(|(o, _, _)| outside < o).unwrap_or(true) {
            best = Some((outside, i, pose_bone));
        }
    }
    best.map(|(_, i, j)| (i, j))
}

/// The tracked controllers as OpenXR actions: a grip pose and a squeeze, per hand.
struct Hands {
    set: openxr::ActionSet,
    #[allow(dead_code)]
    grip: openxr::Action<openxr::Posef>,
    squeeze: openxr::Action<bool>,
    paths: [openxr::Path; crate::bridge::HANDS],
    spaces: Vec<openxr::Space>,
}

impl Hands {
    fn new(xr: &openxr::Instance, session: &openxr::Session<openxr::Vulkan>) -> Result<Self> {
        let paths = [
            xr.string_to_path("/user/hand/left")?,
            xr.string_to_path("/user/hand/right")?,
        ];
        let set = xr.create_action_set("hands", "Hands", 0)?;
        let grip = set.create_action::<openxr::Posef>("grip", "Grip pose", &paths)?;
        let squeeze = set.create_action::<bool>("grab", "Grab", &paths)?;
        // Suggested per profile; the runtime picks the profile for the controller in hand. The
        // Index binds the squeeze to the grip sensor, which is what grabbing feels like; the
        // simple profile has only a select, so that is the grab there.
        let suggest = |profile: &str, squeeze_input: &str| -> Result<()> {
            let mut bindings = Vec::new();
            for side in ["left", "right"] {
                bindings.push(openxr::Binding::new(
                    &grip,
                    xr.string_to_path(&format!("/user/hand/{side}/input/grip/pose"))?,
                ));
                bindings.push(openxr::Binding::new(
                    &squeeze,
                    xr.string_to_path(&format!("/user/hand/{side}/input/{squeeze_input}"))?,
                ));
            }
            xr.suggest_interaction_profile_bindings(xr.string_to_path(profile)?, &bindings)?;
            Ok(())
        };
        suggest("/interaction_profiles/valve/index_controller", "squeeze/value")?;
        if let Err(e) = suggest("/interaction_profiles/khr/simple_controller", "select/click") {
            println!("hands: the simple controller profile was refused ({e}); Index only");
        }
        session.attach_action_sets(&[&set])?;
        let spaces = paths
            .iter()
            .map(|&path| grip.create_space(session, path, openxr::Posef::IDENTITY))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(Self {
            set,
            grip,
            squeeze,
            paths,
            spaces,
        })
    }

    fn sync(&self, session: &openxr::Session<openxr::Vulkan>) -> Result<()> {
        session.sync_actions(&[openxr::ActiveActionSet::new(&self.set)])?;
        Ok(())
    }

    /// Where a hand's grip is in `base` at `time`, if the runtime can say.
    fn locate(
        &self,
        hand: usize,
        base: &openxr::Space,
        time: openxr::Time,
    ) -> Result<Option<([f32; 3], [f32; 4])>> {
        let located = self.spaces[hand].locate(base, time)?;
        let wanted = openxr::SpaceLocationFlags::POSITION_VALID
            | openxr::SpaceLocationFlags::ORIENTATION_VALID;
        if !located.location_flags.contains(wanted) {
            return Ok(None);
        }
        let p = located.pose.position;
        let q = located.pose.orientation;
        Ok(Some(([p.x, p.y, p.z], [q.x, q.y, q.z, q.w])))
    }

    fn squeezing(&self, session: &openxr::Session<openxr::Vulkan>, hand: usize) -> Result<bool> {
        let state = self.squeeze.state(session, self.paths[hand])?;
        Ok(state.is_active && state.current_state)
    }
}

/// Begin a session and run the frame loop for a while, submitting no layers.
///
/// `xrEndFrame` accepts a frame with no layers, which is what makes this worth doing: it exercises
/// `xrWaitFrame`, the session state machine and head tracking without needing a single correct
/// pipeline. If this holds the headset's rate and reports sensible poses, everything left is
/// ordinary Vulkan.
pub fn run_session(seconds: f32) -> Result<()> {
    let entry = unsafe { openxr::Entry::load(&()) }
        .context("opening libopenxr_loader.so.1 -- install an OpenXR runtime (SteamVR, Monado)")?;
    let available = entry.enumerate_extensions()?;
    let mut wanted = openxr::ExtensionSet::default();
    wanted.khr_vulkan_enable2 = available.khr_vulkan_enable2;
    let xr = entry.create_instance(
        &openxr::ApplicationInfo {
            application_name: "bs-humany xr viewer",
            application_version: 1,
            engine_name: "bs-humany",
            engine_version: 1,
            api_version: openxr::Version::new(1, 0, 0),
        },
        &wanted,
        &[],
        &(),
    )?;
    let system = xr.system(openxr::FormFactor::HEAD_MOUNTED_DISPLAY)?;
    let graphics = Graphics::for_runtime(&xr, system)?;

    let (session, mut frame_wait, mut frame_stream) = unsafe {
        xr.create_session::<openxr::Vulkan>(
            system,
            &openxr::vulkan::SessionCreateInfo {
                instance: graphics.instance.handle().as_raw() as _,
                physical_device: graphics.physical.as_raw() as _,
                device: graphics.device.handle().as_raw() as _,
                queue_family_index: graphics.queue_family,
                queue_index: 0,
            },
        )
    }
    .context("creating the OpenXR session")?;

    let stage = session.create_reference_space(
        openxr::ReferenceSpaceType::STAGE,
        openxr::Posef::IDENTITY,
    )?;

    let mut event_storage = openxr::EventDataBuffer::new();
    let mut running = false;
    let mut frames = 0u32;
    let started = std::time::Instant::now();
    let mut first_display: Option<openxr::Time> = None;
    let mut last_display = openxr::Time::from_nanos(0);

    while started.elapsed().as_secs_f32() < seconds {
        while let Some(event) = xr.poll_event(&mut event_storage)? {
            use openxr::Event::*;
            match event {
                SessionStateChanged(e) => {
                    println!("session: {:?}", e.state());
                    match e.state() {
                        openxr::SessionState::READY => {
                            session.begin(openxr::ViewConfigurationType::PRIMARY_STEREO)?;
                            running = true;
                        }
                        openxr::SessionState::STOPPING => {
                            session.end()?;
                            running = false;
                        }
                        openxr::SessionState::EXITING | openxr::SessionState::LOSS_PENDING => {
                            return Ok(());
                        }
                        _ => {}
                    }
                }
                InstanceLossPending(_) => return Ok(()),
                _ => {}
            }
        }
        if !running {
            std::thread::sleep(std::time::Duration::from_millis(50));
            continue;
        }

        let state = frame_wait.wait()?;
        frame_stream.begin()?;
        if state.should_render {
            let (_flags, views) = session.locate_views(
                openxr::ViewConfigurationType::PRIMARY_STEREO,
                state.predicted_display_time,
                &stage,
            )?;
            if frames == 0 {
                for (eye, view) in views.iter().enumerate() {
                    let p = view.pose.position;
                    println!(
                        "  eye {eye} at ({:.3}, {:.3}, {:.3})  fov l{:.2} r{:.2} u{:.2} d{:.2}",
                        p.x, p.y, p.z,
                        view.fov.angle_left, view.fov.angle_right,
                        view.fov.angle_up, view.fov.angle_down
                    );
                }
            }
            first_display.get_or_insert(state.predicted_display_time);
            last_display = state.predicted_display_time;
            frames += 1;
        }
        // No layers. Legal, and the point: this measures the runtime rather than our drawing.
        frame_stream.end(
            state.predicted_display_time,
            openxr::EnvironmentBlendMode::OPAQUE,
            &[],
        )?;
    }

    if let Some(first) = first_display {
        let span = (last_display.as_nanos() - first.as_nanos()) as f64 / 1e9;
        if span > 0.0 {
            println!(
                "{frames} frames over {span:.2} s of predicted display time -- {:.1} Hz",
                (frames - 1) as f64 / span
            );
        }
    } else {
        println!("no frames were asked for: the session never reached a rendering state.");
    }
    Ok(())
}
