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

/// Said when the runtime has neither Vulkan binding: nothing here can draw through it at all.
const NO_VULKAN: &str = "the OpenXR runtime offers no Vulkan binding, so nothing here can render to it";

/// Said when the runtime has only the first Vulkan binding. `view` and `session` build Vulkan
/// through the runtime (`xrCreateVulkanInstanceKHR` and its device twin), which only the second
/// one has; `probe` can still say what the runtime is, through the first.
const VULKAN_ENABLE_ONLY: &str =
    "this runtime offers only KHR_vulkan_enable; view and session need XR_KHR_vulkan_enable2";

/// Said when the runtime answers but has no headset to offer.
///
/// A headset asleep, or one the runtime has not found, is the commonest reason the viewer stops
/// at once, and the runtime's name for it, `ERROR_FORM_FACTOR_UNAVAILABLE`, says nothing to
/// somebody who pressed Connect in the studio and is reading the reason there.
const NO_HEADSET: &str =
    "no headset is available to the OpenXR runtime: wake the headset and check SteamVR/Monado lists it";

/// The OpenXR loader, and the extensions the runtime behind it offers.
fn open_loader() -> Result<(openxr::Entry, openxr::ExtensionSet)> {
    let entry = unsafe { openxr::Entry::load(&()) }
        .context("opening libopenxr_loader.so.1 -- install an OpenXR runtime (SteamVR, Monado)")?;
    // The loader has no extensions of its own to list; this is the first call that reaches the
    // runtime, so it is where a runtime that is missing or not set active shows itself.
    let available = entry
        .enumerate_extensions()
        .context("asking the OpenXR runtime which extensions it has -- is one (SteamVR, Monado) installed and set active?")?;
    Ok((entry, available))
}

/// An instance of the runtime with exactly the extensions in `wanted`.
fn create_instance(entry: &openxr::Entry, wanted: &openxr::ExtensionSet) -> Result<openxr::Instance> {
    entry
        .create_instance(
            &openxr::ApplicationInfo {
                application_name: "bs-humany xr viewer",
                application_version: 1,
                engine_name: "bs-humany",
                engine_version: 1,
                api_version: openxr::Version::new(1, 0, 0),
            },
            wanted,
            &[],
            &(),
        )
        .context("creating the OpenXR instance -- is a runtime installed and active?")
}

/// The head-mounted display, or `None` when the runtime has none to offer right now. Every other
/// refusal is an error, with its code under a sentence saying what was being asked.
fn find_headset(xr: &openxr::Instance) -> Result<Option<openxr::SystemId>> {
    match xr.system(openxr::FormFactor::HEAD_MOUNTED_DISPLAY) {
        Ok(system) => Ok(Some(system)),
        Err(openxr::sys::Result::ERROR_FORM_FACTOR_UNAVAILABLE) => Ok(None),
        Err(e) => Err(e).context("asking the OpenXR runtime for a head-mounted display"),
    }
}

/// The loader, an instance with the Vulkan binding `view` and `session` draw through, and the
/// headset: the three steps both of them take before anything is theirs alone.
///
/// One place, so that each way this can fail is said in one sentence, the same from either: no
/// loader, a runtime with only the older Vulkan binding, a runtime that will not start, or no
/// headset. The studio shows the viewer's last line when it stops, so that line is written for
/// somebody who pressed Connect rather than for somebody reading the OpenXR specification.
/// `probe` takes the same steps one at a time, printing between them, and uses these pieces.
fn bring_up() -> Result<(openxr::Entry, openxr::Instance, openxr::SystemId)> {
    let (entry, available) = open_loader()?;
    if !available.khr_vulkan_enable2 {
        bail!(if available.khr_vulkan_enable { VULKAN_ENABLE_ONLY } else { NO_VULKAN });
    }
    let mut wanted = openxr::ExtensionSet::default();
    wanted.khr_vulkan_enable2 = true;
    let xr = create_instance(&entry, &wanted)?;
    let Some(system) = find_headset(&xr)? else {
        bail!(NO_HEADSET);
    };
    Ok((entry, xr, system))
}

/// What the loader and runtime say before any hardware is involved.
pub fn probe() -> Result<()> {
    let (entry, available) = open_loader()?;
    println!("OpenXR loader: found");
    println!(
        "  KHR_vulkan_enable2: {}   KHR_vulkan_enable: {}",
        available.khr_vulkan_enable2, available.khr_vulkan_enable
    );
    for layer in entry.enumerate_layers().unwrap_or_default() {
        println!("  layer: {}", layer.layer_name);
    }
    if !available.khr_vulkan_enable2 && !available.khr_vulkan_enable {
        bail!(NO_VULKAN);
    }
    // A runtime with only the first binding is still worth describing, through that binding, but
    // it is said up front that view and session will refuse it, rather than left to be found.
    if !available.khr_vulkan_enable2 {
        println!("  cannot run view or session: {VULKAN_ENABLE_ONLY}");
    }

    let mut wanted = openxr::ExtensionSet::default();
    wanted.khr_vulkan_enable2 = available.khr_vulkan_enable2;
    wanted.khr_vulkan_enable = !available.khr_vulkan_enable2 && available.khr_vulkan_enable;
    let instance = create_instance(&entry, &wanted)?;

    let properties = instance.properties().context("asking the OpenXR runtime its name")?;
    println!(
        "runtime: {} {}",
        properties.runtime_name, properties.runtime_version
    );

    // From here on a headset has to exist. This is the line that tells somebody with nothing
    // plugged in that nothing is plugged in, rather than failing later and vaguely.
    let Some(system) = find_headset(&instance)? else {
        println!("system: {NO_HEADSET}.");
        println!("        (The loader and runtime are fine; there is no headset to ask.)");
        return Ok(());
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
    if !available.khr_vulkan_enable2 {
        println!("verdict: the headset is there, but view and session cannot run: {VULKAN_ENABLE_ONLY}");
    }
    Ok(())
}

/// Whether the frame loop carries on, or the runtime has said this session is over.
#[derive(Debug, PartialEq)]
enum Flow {
    Continue,
    Exit,
}

/// Read every event the runtime has queued and act on the ones that change what the loop does.
///
/// The session state machine is the runtime's, not ours: READY means begin, STOPPING means end
/// (the headset taken off, or another app in front), and EXITING, LOSS_PENDING or the instance
/// itself going away mean stop altogether. `running` is whether a session is begun, which is
/// whether there are frames to wait on. `view` and `session` walk that machine the same way,
/// which is why there is one copy of it.
fn pump_events(
    xr: &openxr::Instance,
    session: &openxr::Session<openxr::Vulkan>,
    storage: &mut openxr::EventDataBuffer,
    running: &mut bool,
) -> Result<Flow> {
    while let Some(event) = xr.poll_event(storage).context("reading the OpenXR runtime's events")? {
        use openxr::Event::*;
        match event {
            SessionStateChanged(e) => {
                println!("session: {:?}", e.state());
                match e.state() {
                    openxr::SessionState::READY => {
                        session
                            .begin(openxr::ViewConfigurationType::PRIMARY_STEREO)
                            .context("beginning the OpenXR session the runtime said was ready")?;
                        *running = true;
                    }
                    openxr::SessionState::STOPPING => {
                        session.end().context("ending the OpenXR session the runtime is stopping")?;
                        *running = false;
                    }
                    openxr::SessionState::EXITING | openxr::SessionState::LOSS_PENDING => {
                        return Ok(Flow::Exit);
                    }
                    _ => {}
                }
            }
            InstanceLossPending(_) => {
                println!("session: the OpenXR runtime is going away");
                return Ok(Flow::Exit);
            }
            _ => {}
        }
    }
    Ok(Flow::Continue)
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
        let requirements = xr
            .graphics_requirements::<openxr::Vulkan>(system)
            .context("asking the OpenXR runtime which Vulkan versions it accepts")?;
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

        let physical = vk::PhysicalDevice::from_raw(
            unsafe { xr.vulkan_graphics_device(system, instance.handle().as_raw() as _) }
                .context("asking the OpenXR runtime which GPU drives the headset")? as _,
        );

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
    let (_entry, xr, system) = bring_up()?;
    let graphics = Graphics::for_runtime(&xr, system)?;

    let configs = xr
        .enumerate_view_configuration_views(system, openxr::ViewConfigurationType::PRIMARY_STEREO)
        .context("asking the OpenXR runtime what size to draw each eye")?;
    let eye = configs
        .first()
        .context("the OpenXR runtime described a stereo headset with no views to draw")?;
    let extent = ash::vk::Extent2D {
        width: eye.recommended_image_rect_width,
        height: eye.recommended_image_rect_height,
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
    }
    .context("creating the OpenXR session")?;

    // The runtime's preferred format, filtered to the ones this pipeline writes. Taking its first
    // choice is what keeps the compositor from converting every frame.
    let offered = session
        .enumerate_swapchain_formats()
        .context("asking the OpenXR runtime which swapchain formats it offers")?;
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
    })
    .context("creating the two-layer swapchain both eyes are drawn into")?;
    let images: Vec<ash::vk::Image> = swapchain
        .enumerate_images()
        .context("asking the OpenXR runtime for the swapchain's images")?
        .into_iter()
        .map(|i| ash::vk::Image::from_raw(i))
        .collect();

    // The hands. One action set: where each grip and aim is, whether it is squeezing, whether it
    // is pulling the trigger. Bound for the Index controller this was built against and for the
    // simple profile every runtime knows, so a headset with some other controller still gets a
    // button that grabs and one that points.
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

    // Where the body stands: the simulation's ground lifted to the stage floor. Known once the
    // status says the ground's height; zero, which is nearly every scenario, until then.
    let mut ground = 0.0f32;
    let mut place = crate::render::placement(ground);
    // Bones, the two controllers, the world slot at the placement, a pointer mark a hand, the
    // grid at the identity, and the scenery at the placement.
    let mut matrices: Vec<[f32; 16]> = vec![
        place;
        pack.bones.len()
            + crate::render::CONTROLLERS
            + 1
            + crate::render::MARKERS
            + 1
            + crate::render::SCENE_SLOTS
    ];
    for hand in 0..crate::render::MARKERS {
        matrices[renderer.marker_slot(hand)] = crate::render::scale_matrix(0.0);
    }
    // The grid is the stage itself: the identity.
    matrices[renderer.stage_slot()] = crate::render::scale_matrix(1.0);

    // What is followed: the pose bridge, the muscles beside it, the grab channel back. Opened
    // together, and reopened together whenever the publisher's generation changes, which is how
    // a scenario switch reaches this side, or the files at their names are not the ones mapped,
    // which is how a publisher that restarted from the same generation does.
    // Opened now if the publisher is already there; otherwise the loop keeps trying every status
    // poll, drawing the rest pose meanwhile, because "viewer first, then the run" is a perfectly
    // good order to do things in and the studio's Connect button does exactly that.
    let mut feeds = match follow {
        Some(path) => match Feeds::open(path, pack, &mut renderer) {
            Ok(f) => Some(f),
            Err(e) => {
                println!("waiting for a publisher at {}: {e}", path.display());
                None
            }
        },
        None => None,
    };
    let status_path = follow.map(|p| std::path::PathBuf::from(format!("{}-status.json", p.display())));
    let mut publisher = StatusFeed::default();
    let mut said = SaidLiveness::Fine;
    let mut commands = match follow {
        Some(path) => Some(crate::bridge::CommandWriter::create(&std::path::PathBuf::from(
            format!("{}-commands.jsonl", path.display()),
        ))?),
        None => None,
    };
    let mut holding: [Option<Hold>; crate::bridge::HANDS] = [None, None];
    let mut hand_seen = [false; crate::bridge::HANDS];
    // A trigger that was already down when its ray reached the panel presses nothing until it
    // is let go: squeezing to grab a bone tends to pull the trigger too, and the ray sweeping
    // the panel then was clicking whatever it crossed.
    let mut trigger_armed = [true; crate::bridge::HANDS];
    // Pressed past six tenths, released under a quarter: a trigger held anywhere between stays
    // what it was, so a hand resting on the trigger does not click.
    let mut trigger_down = [false; crate::bridge::HANDS];
    let mut scene_generation: Option<u64> = None;
    // Moving about: the sticks carry the viewer through the world, which is to say the world is
    // moved the other way under a stage that does not move. `view_point` is where the stage
    // origin sits in the world and how far the world is turned about the viewer; everything of
    // the world is drawn through `shift`, and the hands, which are of the stage, are not.
    let mut view_point = Viewpoint::default();
    let mut last_frame = std::time::Instant::now();
    const WALK_SPEED: f32 = 2.0; // m/s at full deflection
    const TURN_SPEED: f32 = 1.6; // radians a second at full deflection, a little over a right angle
    const LIFT_SPEED: f32 = 1.2; // m/s at full deflection
    const DEAD_ZONE: f32 = 0.15;
    let controller_scale = crate::render::scale_matrix(1.0);
    let mut muscle_vertices: Vec<f32> = Vec::new();
    let mut tissue_vertices: Vec<f32> = Vec::new();
    // The connective tissue's fixed shape, rebuilt when the publisher's generation changes.
    let mut tissue_shape: Option<crate::tissue::TissueShape> = None;
    let mut tissue_generation: Option<u64> = None;
    let mut last_tick: Option<u64> = None;
    let mut last_muscle_tick: Option<u64> = None;

    // The panels: the properties panel to the viewer's right of the body, a little below eye
    // height, and the transport strip under it, both turned to face where the viewer stands.
    // Whichever hand is pointing at a panel is its pointer; a hand that pressed on it keeps being
    // the pointer until it lets go, so a drag does not change hands mid-way. A hand on a grab
    // strip carries the panel instead.
    use crate::panel::{Held, Hit, Kind, Panel, Placement};
    let mut placements = [
        Placement::facing(Kind::Properties.size(), [0.95, 1.3, -1.0], [0.0, 1.3, 0.0]),
        Placement::facing(Kind::Transport.size(), [0.55, 0.76, -1.05], [0.0, 0.76, 0.0]),
    ];
    let mut panels = [Panel::new(Kind::Properties), Panel::new(Kind::Transport)];
    let mut pointer_hand: [Option<usize>; 2] = [None, None];
    let mut carrying: [Option<(usize, Held)>; crate::bridge::HANDS] = [None, None];

    let stage = session
        .create_reference_space(openxr::ReferenceSpaceType::STAGE, openxr::Posef::IDENTITY)
        .context("asking the OpenXR runtime for the room's floor (the stage space)")?;
    let mut event_storage = openxr::EventDataBuffer::new();
    let mut running = false;
    let mut frames = 0u32;
    let mut last_poll: Option<std::time::Instant> = None;
    let mut worst_cpu = 0f64;
    let started = std::time::Instant::now();
    // Reported as it goes rather than only at the end, because the natural way to stop watching
    // something in a headset is to take it off and press Ctrl-C, and a summary that only prints
    // on a clean exit is a summary nobody ever sees.
    let mut window_started = started;
    let mut window_frames = 0u32;
    let mut window_worst = 0f64;

    while started.elapsed().as_secs_f32() < seconds {
        if pump_events(&xr, &session, &mut event_storage, &mut running)? == Flow::Exit {
            // Nothing is destroyed while the GPU may still be drawing into it.
            renderer.wait_idle();
            return Ok(());
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

        // The publisher's status, ten times a second by the clock rather than by the frame, so a
        // 144 Hz headset and a 90 Hz one poll at the rate every publisher writes; and the feeds
        // reopened if its generation moved or its files were replaced. A publisher that has not
        // written a status yet, or that has stopped and removed it, is simply not there this
        // poll. None of this waits on the publisher: a stat and a read of a small file on tmpfs.
        if last_poll.map_or(true, |at| at.elapsed() >= STATUS_POLL) {
            last_poll = Some(std::time::Instant::now());
            if let (None, Some(follow_path)) = (feeds.as_ref(), follow) {
                if let Ok(opened) = Feeds::open(follow_path, pack, &mut renderer) {
                    feeds = Some(opened);
                    last_tick = None;
                    last_muscle_tick = None;
                    muscle_vertices.clear();
                    reopen_commands(&mut commands);
                }
            }
            if let Some(path) = &status_path {
                publisher.observe(read_status_file(path), std::time::Instant::now());
            }
            if let (Some(f), Some(follow_path)) = (feeds.as_ref(), follow) {
                // The generation is only trusted from a status that read cleanly: the feeds
                // take theirs from the file when they open, and one that did not parse then
                // would disagree with the last good status at every poll. The files' identity
                // needs no status at all.
                let why = match publisher.status.as_ref() {
                    Some(s) if publisher.error.is_none() && s.generation != f.generation => {
                        Some(format!("generation {}", s.generation))
                    }
                    _ if crate::bridge::feeds_changed(follow_path, &f.mapped) => {
                        Some(if crate::bridge::file_id(follow_path) != f.mapped.pose {
                            "pose file replaced".to_string()
                        } else {
                            "muscle ring came or went".to_string()
                        })
                    }
                    _ => None,
                };
                if let Some(why) = why {
                    println!("publisher: {why}, reopening the bridges");
                    match Feeds::open(follow_path, pack, &mut renderer) {
                        Ok(reopened) => {
                            feeds = Some(reopened);
                            holding = [None, None];
                            last_tick = None;
                            last_muscle_tick = None;
                            muscle_vertices.clear();
                            // A publisher that restarted may have kept its generation, so the
                            // scene and the tissue are taken again from whatever it says next,
                            // rather than only when the number moves.
                            scene_generation = None;
                            tissue_generation = None;
                            reopen_commands(&mut commands);
                        }
                        Err(e) => println!("publisher: could not reopen yet: {e}"),
                    }
                }
            }
            // The scenery, once a generation. `set_scene` waits for the device to idle and
            // reallocates, so it is never called on a poll that changed nothing.
            if let Some(s) = publisher.status.as_ref() {
                if scene_generation != Some(s.generation) {
                    scene_generation = Some(s.generation);
                    ground = s.ground_height as f32;
                    place = crate::render::placement(ground);
                    matrices[renderer.world_slot()] = place;
                    matrices[renderer.scene_slot()] = place;
                    renderer.set_scene(&s.static_boxes)?;
                    println!(
                        "scene: ground at {:.2} m, {} static boxes",
                        s.ground_height,
                        s.static_boxes.len()
                    );
                }
            }
            // The tissue's shape, from the status's table and the bridge's bone order, once a
            // generation -- or when a table first arrives from a publisher that had none.
            if let (Some(f), Some(s)) = (feeds.as_ref(), publisher.status.as_ref()) {
                let table_arrived = tissue_shape.is_none() && !s.tissue.discs.is_empty();
                if tissue_generation != Some(f.generation) || table_arrived {
                    tissue_generation = Some(f.generation);
                    let shape = crate::tissue::TissueShape::new(&s.tissue, &f.bridge.names);
                    renderer.enable_tissue(&shape.indices, shape.vertex_count * 7)?;
                    tissue_vertices.clear();
                    if shape.is_empty() {
                        tissue_shape = None;
                    } else {
                        println!(
                            "tissue: {} discs and beads, {} bars",
                            s.tissue.discs.len(),
                            s.tissue.bars.len()
                        );
                        tissue_shape = Some(shape);
                    }
                }
            }
        }

        // The newest pose, if there is one and it is newer than the one already applied. Per
        // ADR-012 this never waits: no frame yet, or one mid-write, means the matrices stand.
        if let Some(f) = feeds.as_mut() {
            if let Some(frame) = f.bridge.newest() {
                if last_tick != Some(frame.tick) {
                    last_tick = Some(frame.tick);
                    let b = &f.bridge;
                    let scale = crate::render::scale_matrix(b.dataset_scale as f32);
                    for (i, found) in f.pose_index.iter().enumerate() {
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
                    if let Some(shape) = &tissue_shape {
                        shape.vertices(&frame.pose, &mut tissue_vertices);
                    }
                }
            }
            if let Some(m) = f.muscles.as_mut() {
                if let Some(frame) = m.newest() {
                    if last_muscle_tick != Some(frame.tick) {
                        last_muscle_tick = Some(frame.tick);
                        let tension: &[f32] =
                            publisher.status.as_ref().map(|s| s.tension.as_slice()).unwrap_or(&[]);
                        crate::render::tube_vertices(
                            &frame.rings,
                            m.rings,
                            m.segments,
                            renderer.world_slot() as u32,
                            tension,
                            &mut muscle_vertices,
                        );
                    }
                }
            }
        }

        hands.sync(&session)?;

        // Walking: the left stick, in the frame of where the head is looking, flattened.
        let now = std::time::Instant::now();
        let dt = (now - last_frame).as_secs_f32().min(0.1);
        last_frame = now;
        let head = views[0].pose.position;
        let head = [head.x, head.y, head.z];
        let stick = hands.thumbstick(&session, 0)?;
        let deflection = (stick[0] * stick[0] + stick[1] * stick[1]).sqrt();
        if deflection > DEAD_ZONE {
            let q = views[0].pose.orientation;
            let mut forward = crate::render::rotate([0.0, 0.0, -1.0], [q.x, q.y, q.z, q.w]);
            forward[1] = 0.0;
            let length = (forward[0] * forward[0] + forward[2] * forward[2]).sqrt().max(1e-6);
            forward = [forward[0] / length, 0.0, forward[2] / length];
            let right = [-forward[2], 0.0, forward[0]];
            let scale = WALK_SPEED * dt * ((deflection - DEAD_ZONE) / (1.0 - DEAD_ZONE)) / deflection;
            // The step is in the frame of the head, which is of the stage; it is spent on the
            // world, so it is turned there first.
            let step = view_point.to_world_direction([
                (right[0] * stick[0] + forward[0] * stick[1]) * scale,
                (right[1] * stick[0] + forward[1] * stick[1]) * scale,
                (right[2] * stick[0] + forward[2] * stick[1]) * scale,
            ]);
            for axis in 0..3 {
                view_point.offset[axis] += step[axis];
            }
        }
        // Turning and rising: the right stick. Left and right turn the viewer about where the
        // head is, so it is a turn on the spot rather than a swing around the middle of the
        // stage; forward and back lift and lower. Each axis has its own dead zone, so a stick
        // pushed to turn does not also drift upwards.
        let look = hands.thumbstick(&session, 1)?;
        let turn = past_dead_zone(look[0], DEAD_ZONE);
        if turn != 0.0 {
            view_point.turn(turn * TURN_SPEED * dt, head);
        }
        let lift = past_dead_zone(look[1], DEAD_ZONE);
        if lift != 0.0 {
            view_point.offset[1] += lift * LIFT_SPEED * dt;
        }
        let shift = view_point.shift();
        // The overlays as the studio has them; a publisher that says nothing shows everything.
        let overlay = |name: &str| {
            publisher
                .status
                .as_ref()
                .and_then(|s| s.overlays.get(name).copied())
                .unwrap_or(true)
        };
        let show_muscles = overlay("muscles") || overlay("muscleVolumes");
        let show_tissue = overlay("tissue");
        matrices[renderer.stage_slot()] =
            crate::render::scale_matrix(if overlay("grid") { 1.0 } else { 0.0 });
        // What is drawn: the world's slots through the shift, the hands' slots as they are.
        let mut drawn = matrices.clone();
        for (slot, m) in drawn.iter_mut().enumerate() {
            let of_the_hands = (renderer.controller_slot(0)..=renderer.controller_slot(1)).contains(&slot)
                || (renderer.marker_slot(0)..=renderer.marker_slot(1)).contains(&slot);
            if !of_the_hands {
                *m = crate::render::multiply(&shift, &matrices[slot]);
            }
        }
        // The hands: located in the stage like the eyes, drawn as cubes at their grips, and asked
        // whether they are squeezing. A hand the runtime cannot place this frame keeps its last
        // cube and cannot begin a grab, but a grab already begun continues at the last target.
        let mut pointers = [crate::panel::Pointer::default(); 2];
        let mut pointer_candidate: [Option<(usize, egui::Pos2, bool)>; 2] = [None, None];
        for hand in 0..crate::bridge::HANDS {
            let slot = renderer.controller_slot(hand);
            let located = hands.locate(&hands.grip_spaces[hand], &stage, state.predicted_display_time)?;
            if let Some((position, orientation)) = located {
                if !hand_seen[hand] {
                    hand_seen[hand] = true;
                    println!("hand {}: tracked", ["left", "right"][hand]);
                }
                drawn[slot] = crate::render::multiply(
                    &crate::render::pose_matrix(position, orientation),
                    &controller_scale,
                );
            }
            // Where the aim ray meets the panel, if it does: a mark there, and a candidate for
            // being the pointer.
            let marker = renderer.marker_slot(hand);
            drawn[marker] = crate::render::scale_matrix(0.0);
            let pull = hands.trigger(&session, hand)?;
            trigger_down[hand] = if trigger_down[hand] { pull > 0.25 } else { pull > 0.6 };
            let pressed = trigger_down[hand];
            if !pressed {
                trigger_armed[hand] = true;
            }
            let aimed = hands.locate(&hands.aim_spaces[hand], &stage, state.predicted_display_time)?;
            // The panels are of the world; the ray is of the stage. Carry the ray over, turn
            // and all: a viewer who has turned no longer points where the stage says.
            let ray = aimed.map(|(position, orientation)| {
                let q = view_point.to_world_rotation(orientation);
                (
                    view_point.to_world(position),
                    q,
                    crate::render::rotate([0.0, 0.0, -1.0], q),
                )
            });
            // A hand carrying a panel keeps carrying it while the trigger is down, wherever it
            // points; let go, the panel stays.
            if let Some((which, held)) = carrying[hand] {
                match ray {
                    Some((from, q, _)) if pressed => {
                        placements[which] = placements[which].carried(&held, from, q);
                    }
                    Some(_) => {
                        carrying[hand] = None;
                        panels[which].grabbed = false;
                        println!("hand {}: put the panel down", ["left", "right"][hand]);
                    }
                    None => {}
                }
            } else {
                let hit = ray.and_then(|(from, _, forward)| {
                    placements
                        .iter()
                        .enumerate()
                        .find_map(|(which, p)| p.hit(from, forward).map(|h| (which, h)))
                });
                match hit {
                    // A hand that is holding a bone is busy; its ray is not a pointer.
                    Some((which, Hit::Face(at))) if holding[hand].is_none() => {
                        let world = placements[which].to_world(at);
                        let in_stage = view_point.to_stage(world);
                        drawn[marker] = crate::render::pose_matrix(in_stage, [0.0, 0.0, 0.0, 1.0]);
                        let pressing = pressed && trigger_armed[hand];
                        let keep = pointer_hand[which] == Some(hand);
                        if keep || pointer_candidate[which].is_none() {
                            pointer_candidate[which] = Some((hand, at, pressing));
                        }
                    }
                    Some((which, Hit::Grab(at))) if holding[hand].is_none() => {
                        let world = placements[which].to_world(at);
                        let in_stage = view_point.to_stage(world);
                        drawn[marker] = crate::render::pose_matrix(in_stage, [0.0, 0.0, 0.0, 1.0]);
                        let already_carried = carrying.iter().flatten().any(|(w, _)| *w == which);
                        if pressed && trigger_armed[hand] && !already_carried {
                            if let Some((from, q, _)) = ray {
                                carrying[hand] = Some((which, placements[which].held_by(from, q)));
                                panels[which].grabbed = true;
                                // This press is the grab; it clicks nothing when it ends.
                                trigger_armed[hand] = false;
                                println!("hand {}: took the panel", ["left", "right"][hand]);
                            }
                        }
                    }
                    _ => {
                        if pressed {
                            trigger_armed[hand] = false;
                        }
                    }
                }
            }
            let Some(f) = feeds.as_mut() else { continue };
            let squeezing = hands.squeezing(&session, hand)?;
            let intent = match (&holding[hand], squeezing, located) {
                (None, true, Some((hand_at, hand_q))) => {
                    // A grab begins: the nearest point on the nearest bone's surface, if any is
                    // within reach. Nothing in reach is a squeeze in empty air, which sends
                    // nothing and holds nothing. From here the point rides with the hand.
                    match nearest_surface(pack, &drawn, &f.pose_index, f.bridge.dataset_scale as f32, hand_at) {
                        Some((pack_bone, pose_bone, surface)) => {
                            println!(
                                "hand {}: grabbed {}",
                                ["left", "right"][hand],
                                pack.bones[pack_bone].id
                            );
                            // The surface is in the stage; the simulation wants the world.
                            let point = crate::render::unplace(view_point.to_world(surface), ground);
                            holding[hand] = Some(Hold {
                                pose_bone,
                                point,
                                offset: [
                                    surface[0] - hand_at[0],
                                    surface[1] - hand_at[1],
                                    surface[2] - hand_at[2],
                                ],
                                hand_q,
                            });
                            crate::bridge::GrabIntent {
                                active: true,
                                bone: pose_bone as i32,
                                point,
                                target: point,
                                strength: 1.0,
                                rotation: crate::render::unplace_rotation(
                                    view_point.to_world_rotation(hand_q),
                                ),
                            }
                        }
                        None => crate::bridge::GrabIntent::default(),
                    }
                }
                (Some(hold), true, at) => {
                    // The grabbed point, carried by the hand: its offset from the hand at the
                    // grab, turned by however much the hand has turned since.
                    let (target, rotation) = match at {
                        Some((hand_at, hand_q)) => {
                            let delta = crate::render::quaternion_multiply(
                                hand_q,
                                crate::render::quaternion_conjugate(hold.hand_q),
                            );
                            let carried = crate::render::rotate(hold.offset, delta);
                            (
                                crate::render::unplace(
                                    view_point.to_world([
                                        hand_at[0] + carried[0],
                                        hand_at[1] + carried[1],
                                        hand_at[2] + carried[2],
                                    ]),
                                    ground,
                                ),
                                crate::render::unplace_rotation(
                                    view_point.to_world_rotation(hand_q),
                                ),
                            )
                        }
                        None => (
                            hold.point,
                            crate::render::unplace_rotation(
                                view_point.to_world_rotation(hold.hand_q),
                            ),
                        ),
                    };
                    crate::bridge::GrabIntent {
                        active: true,
                        bone: hold.pose_bone as i32,
                        point: hold.point,
                        target,
                        strength: 1.0,
                        rotation,
                    }
                }
                (Some(_), false, _) => {
                    println!("hand {}: let go", ["left", "right"][hand]);
                    holding[hand] = None;
                    crate::bridge::GrabIntent::default()
                }
                _ => crate::bridge::GrabIntent::default(),
            };
            f.grabs.publish(hand, &intent);
        }
        for which in 0..2 {
            match pointer_candidate[which] {
                Some((hand, at, pressed)) => {
                    pointer_hand[which] = if pressed { Some(hand) } else { None };
                    pointers[which] = crate::panel::Pointer {
                        at: Some(at),
                        pressed,
                    };
                }
                None => pointer_hand[which] = None,
            }
        }

        // How lively the publisher is: how long since the status last changed and since a new
        // pose arrived, which the panels say in numbers and, past a threshold, in words.
        let status_age = publisher.age();
        let pose_age = feeds.as_ref().map(|f| f.bridge.stale_for());
        let alive = liveness(
            status_age,
            pose_age,
            publisher.status.as_ref().is_some_and(|s| s.paused),
        );
        said = said.report(alive.as_ref());
        let status_age_text = match status_age {
            Some(age) => format!("status {:.1} s old", age.as_secs_f64()),
            None => "no status".to_string(),
        };
        let feeds_line = match (&feeds, follow) {
            (Some(f), _) => format!(
                "{} of {} bones posed, {}, pose {:.0} ms old, {status_age_text}",
                f.pose_index.iter().filter(|m| m.is_some()).count(),
                pack.bones.len(),
                if f.muscles.is_some() { "muscles on" } else { "no muscles" },
                f.bridge.stale_for().as_secs_f64() * 1000.0,
            ),
            (None, Some(path)) => format!(
                "Waiting for a publisher at {}: start a run in the studio, or `pnpm publish:pose`.",
                path.display()
            ),
            (None, None) => "Not following a simulation: run with --follow.".to_string(),
        };
        // The panels, laid out afresh; their textures applied before the draw that samples them,
        // and what was pressed sent on.
        let mut panel_meshes = Vec::with_capacity(2);
        for (which, panel) in panels.iter_mut().enumerate() {
            let frame = panel.run(
                publisher.status.as_ref(),
                pointers[which],
                &feeds_line,
                alive.as_ref(),
                publisher.error.as_deref(),
            );
            if !frame.textures.is_empty() {
                renderer.update_panel_textures(&frame.textures)?;
            }
            if let Some(writer) = commands.as_mut() {
                for command in &frame.commands {
                    println!("panel: {command:?}");
                    // A press that cannot be written is lost, and said so; it is no reason to
                    // take the headset's view away.
                    if let Err(e) = writer.send(&command.to_json()) {
                        println!("panel: could not send {command:?}: {e:#}");
                    }
                }
            }
            panel_meshes.push(frame.meshes);
        }
        let panel_draws: Vec<crate::render::PanelDraw> = placements
            .iter()
            .zip(panel_meshes.iter())
            .map(|(placement, meshes)| crate::render::PanelDraw {
                model: crate::render::multiply(&shift, &placement.model()),
                meshes,
            })
            .collect();

        let image = swapchain.acquire_image()?;
        swapchain.wait_image(openxr::Duration::INFINITE)?;
        renderer.draw(
            image as usize,
            &crate::render::view_projections(&views, 0.05, 50.0),
            Some(drawn.as_slice()),
            if muscle_vertices.is_empty() || !show_muscles { None } else { Some(muscle_vertices.as_slice()) },
            if tissue_vertices.is_empty() || !show_tissue { None } else { Some(tissue_vertices.as_slice()) },
            &panel_draws,
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
            let pose_age = feeds
                .as_ref()
                .map(|f| format!(", pose {:.0} ms old", f.bridge.stale_for().as_secs_f64() * 1000.0))
                .unwrap_or_default();
            let held = holding
                .iter()
                .flatten()
                .map(|h| feeds.as_ref().map(|f| f.bridge.names[h.pose_bone].clone()).unwrap_or_default())
                .collect::<Vec<_>>()
                .join(" and ");
            let held = if held.is_empty() { held } else { format!(", holding {held}") };
            let bellies = feeds
                .as_ref()
                .and_then(|f| f.muscles.as_ref())
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

/// Everything read from or written to one generation of the publisher's files.
struct Feeds {
    generation: u64,
    bridge: crate::bridge::PoseBridge,
    muscles: Option<crate::bridge::MuscleBridge>,
    grabs: crate::bridge::GrabIntentWriter,
    /// For each pack bone, its index in the bridge's bone order, matched by name once.
    pose_index: Vec<Option<usize>>,
    /// Which files these are, so a publisher that replaces them is noticed even when it keeps
    /// its generation.
    mapped: crate::bridge::MappedId,
}

impl Feeds {
    fn open(
        path: &std::path::Path,
        pack: &crate::pack::Pack,
        renderer: &mut crate::render::Renderer,
    ) -> Result<Self> {
        let bridge = crate::bridge::PoseBridge::open(path)?;
        // Matched by name once, because the pack and the pose are in different orders and the
        // pose may carry bones the pack has no mesh for.
        let pose_index: Vec<Option<usize>> = pack
            .bones
            .iter()
            .map(|bone| bridge.names.iter().position(|n| *n == bone.id))
            .collect();
        println!(
            "following {}: {} of {} pack bones have a pose, dataset scale {:.4}",
            path.display(),
            pose_index.iter().filter(|m| m.is_some()).count(),
            pack.bones.len(),
            bridge.dataset_scale
        );
        // The muscles, if the simulation has them: rings in their own bridge beside the poses,
        // swept into tubes every time a new frame arrives. A publisher with muscles off writes
        // no such file, which is not an error.
        let muscle_path = crate::bridge::muscle_path(path);
        let muscles = match crate::bridge::MuscleBridge::open(&muscle_path) {
            Ok(m) => {
                println!(
                    "muscles: {} bellies of {} rings, {} segments round",
                    m.units, m.rings, m.segments
                );
                renderer.enable_muscles(m.units, m.rings, m.segments)?;
                Some(m)
            }
            Err(e) => {
                if muscle_path.exists() {
                    println!("muscles: {e:#}");
                } else {
                    println!("muscles: none published");
                }
                None
            }
        };
        let mapped = crate::bridge::MappedId {
            pose: bridge.id,
            muscles: match &muscles {
                Some(m) => m.id,
                None => crate::bridge::file_id(&muscle_path),
            },
        };
        let grabs = crate::bridge::GrabIntentWriter::create(&std::path::PathBuf::from(format!(
            "{}-grab",
            path.display()
        )))?;
        let generation = crate::bridge::read_status(&std::path::PathBuf::from(format!(
            "{}-status.json",
            path.display()
        )))
        .map(|s| s.generation)
        .unwrap_or(0);
        Ok(Self {
            generation,
            mapped,
            bridge,
            muscles,
            grabs,
            pose_index,
        })
    }
}

/// How often the publisher's status is read: every publisher writes it about this often, so a
/// faster poll would read the same file twice and a slower one would lag a scenario switch.
const STATUS_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// The status file as it stands: when it was last modified, and its text.
fn read_status_file(path: &std::path::Path) -> std::io::Result<(Option<std::time::SystemTime>, String)> {
    let modified = std::fs::metadata(path)?.modified().ok();
    Ok((modified, std::fs::read_to_string(path)?))
}

/// Point the command log at whatever file is at its name now: a new publisher has just been
/// found, and it may have removed the old one.
fn reopen_commands(commands: &mut Option<crate::bridge::CommandWriter>) {
    if let Some(writer) = commands.as_mut() {
        if let Err(e) = writer.reopen() {
            println!("panel: could not reopen the command log: {e:#}");
        }
    }
}

/// The publisher's status as the viewer follows it: the last one that parsed, why the newest one
/// did not if it did not, and when it last changed.
#[derive(Default)]
struct StatusFeed {
    status: Option<crate::bridge::Status>,
    /// Why the file that is there now is not a status, in serde's words. The last good status is
    /// kept beside it, so the panels still show where things stood, but they say this at the
    /// top: a panel that has silently stopped changing is the thing this is here to prevent.
    error: Option<String>,
    /// When the status last changed. Every publisher renames a new file into place on every
    /// write and puts its wall-clock seconds in it, so the text changes whenever it is alive,
    /// and the modification time is compared too for one that writes the same text twice.
    seen: Option<std::time::Instant>,
    last: Option<(Option<std::time::SystemTime>, String)>,
}

impl StatusFeed {
    /// Take one reading of the status file, parsed only if it is not the reading before.
    fn observe(
        &mut self,
        reading: std::io::Result<(Option<std::time::SystemTime>, String)>,
        now: std::time::Instant,
    ) {
        match reading {
            // No file: the publisher has not started, or has stopped and cleaned up. There is
            // nothing to show, and nothing is wrong with a status that is not there.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if self.status.is_some() || self.error.is_some() {
                    println!("status: gone");
                }
                *self = Self::default();
            }
            Err(e) => self.fail(e.to_string()),
            Ok(reading) => {
                if self.last.as_ref() == Some(&reading) {
                    return;
                }
                self.seen = Some(now);
                match crate::bridge::parse_status(&reading.1) {
                    Ok(status) => {
                        if self.error.take().is_some() {
                            println!("status: readable again");
                        }
                        self.status = Some(status);
                    }
                    Err(e) => self.fail(e.to_string()),
                }
                self.last = Some(reading);
            }
        }
    }

    /// Keep the reason, and say it on the terminal once rather than ten times a second.
    fn fail(&mut self, why: String) {
        if self.error.as_deref() != Some(why.as_str()) {
            println!("status unreadable: {why}");
        }
        self.error = Some(why);
    }

    /// How long since the status last changed.
    fn age(&self) -> Option<std::time::Duration> {
        self.seen.map(|at| at.elapsed())
    }
}

/// What is wrong with the publisher, as far as the headset can tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Liveness {
    /// The status has not changed for this many whole seconds: whatever was writing it is gone
    /// or stuck, and nothing pressed on a panel will be read.
    Silent(u64),
    /// The status is fresh and says the run is not paused, but no new pose has come for a while.
    NotAdvancing,
}

impl Liveness {
    /// What the panels say, in words somebody in a headset can act on.
    pub fn message(&self) -> String {
        match self {
            Liveness::Silent(seconds) => format!(
                "Publisher silent for {seconds} s: the studio or publish:pose has stopped"
            ),
            Liveness::NotAdvancing => {
                "Simulation not advancing: the publisher is there but no new pose has come".to_string()
            }
        }
    }
}

/// A status this much older than the last one is a publisher that has stopped. Three seconds,
/// not one: the training showcase stops writing for 1.2 s between episodes, and every publisher
/// writes at least four times a second while it lives.
const SILENT_AFTER: std::time::Duration = std::time::Duration::from_secs(3);
/// A status seen this recently is a publisher that is certainly still there.
const FRESH: std::time::Duration = std::time::Duration::from_secs(1);
/// A pose this old, from a run that is not paused, is a simulation that is not moving.
const POSE_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(1);
/// How much longer ago the last pose must be than the last status. Both stop together when a
/// publisher pauses between episodes, as the showcase does, and a status noticed a poll after the
/// last pose must not read as a publisher that talks without moving; one that is really stuck
/// goes on writing its status while the pose ages past this.
const TALKING_WITHOUT_MOVING: std::time::Duration = std::time::Duration::from_millis(500);

/// Whether to warn about the publisher, from how long ago its status last changed and a new pose
/// last came, and whether it says it is paused. Paused, a still body is what was asked for.
pub fn liveness(
    status_age: Option<std::time::Duration>,
    pose_age: Option<std::time::Duration>,
    paused: bool,
) -> Option<Liveness> {
    let status_age = status_age?;
    if status_age > SILENT_AFTER {
        return Some(Liveness::Silent(status_age.as_secs()));
    }
    let pose_age = pose_age?;
    let talking_without_moving = pose_age
        .checked_sub(status_age)
        .is_some_and(|gap| gap >= TALKING_WITHOUT_MOVING);
    if !paused && status_age <= FRESH && pose_age > POSE_STALE_AFTER && talking_without_moving {
        return Some(Liveness::NotAdvancing);
    }
    None
}

/// What the terminal was last told about the publisher's liveness, so it is told of a change
/// once, rather than every frame, and a silence is not reported again every second it lasts.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SaidLiveness {
    Fine,
    Silent,
    NotAdvancing,
}

impl SaidLiveness {
    fn report(self, now: Option<&Liveness>) -> Self {
        let next = match now {
            None => SaidLiveness::Fine,
            Some(Liveness::Silent(_)) => SaidLiveness::Silent,
            Some(Liveness::NotAdvancing) => SaidLiveness::NotAdvancing,
        };
        if next != self {
            match now {
                Some(l) => println!("publisher: {}", l.message()),
                None => println!("publisher: live again"),
            }
        }
        next
    }
}

/// Where the viewer stands in the world and how far they have turned: the stage does not move,
/// so walking, turning and rising are all the world moving underneath it. `offset` is where the
/// stage origin sits in the world; `yaw` is how far the world is turned about the viewer, growing
/// as the viewer turns to their right.
#[derive(Clone, Copy, Default)]
struct Viewpoint {
    offset: [f32; 3],
    yaw: f32,
}

impl Viewpoint {
    /// The turn the world is drawn through.
    fn spin(&self) -> [f32; 4] {
        [0.0, (self.yaw * 0.5).sin(), 0.0, (self.yaw * 0.5).cos()]
    }

    /// A point of the world, where the stage has it.
    fn to_stage(&self, p: [f32; 3]) -> [f32; 3] {
        crate::render::rotate(
            [p[0] - self.offset[0], p[1] - self.offset[1], p[2] - self.offset[2]],
            self.spin(),
        )
    }

    /// A point of the stage -- a hand, a mark -- where the world has it.
    fn to_world(&self, p: [f32; 3]) -> [f32; 3] {
        let turned = self.to_world_direction(p);
        [turned[0] + self.offset[0], turned[1] + self.offset[1], turned[2] + self.offset[2]]
    }

    /// A direction of the stage in the world: the turn without the walk.
    fn to_world_direction(&self, v: [f32; 3]) -> [f32; 3] {
        crate::render::rotate(v, crate::render::quaternion_conjugate(self.spin()))
    }

    /// A rotation of the stage -- a hand's -- in the world.
    fn to_world_rotation(&self, q: [f32; 4]) -> [f32; 4] {
        crate::render::quaternion_multiply(crate::render::quaternion_conjugate(self.spin()), q)
    }

    /// The matrix everything of the world is drawn through.
    fn shift(&self) -> [f32; 16] {
        crate::render::multiply(
            &crate::render::pose_matrix([0.0, 0.0, 0.0], self.spin()),
            &crate::render::translation_matrix([-self.offset[0], -self.offset[1], -self.offset[2]]),
        )
    }

    /// Turn by `by` radians about where the head is, so the world under the head stays under it
    /// and the viewer turns on the spot. `head` is in the stage.
    fn turn(&mut self, by: f32, head: [f32; 3]) {
        let was = self.to_world(head);
        self.yaw += by;
        let now = self.to_world(head);
        for axis in 0..3 {
            self.offset[axis] += was[axis] - now[axis];
        }
    }
}

/// One axis of a stick past its dead zone, rescaled so that it starts from nothing.
fn past_dead_zone(v: f32, dead: f32) -> f32 {
    if v.abs() <= dead {
        0.0
    } else {
        v.signum() * (v.abs() - dead) / (1.0 - dead)
    }
}

/// What a hand is holding: which pose bone, where in the simulation's frame it took hold, and
/// how the grabbed point sat relative to the hand in the room at that moment.
struct Hold {
    pose_bone: usize,
    point: [f32; 3],
    /// Grabbed point minus hand position, in the stage, at the grab.
    offset: [f32; 3],
    /// The hand's orientation in the stage, at the grab.
    hand_q: [f32; 4],
}

/// The nearest point on a bone's surface to a hand in the room, with the bone, if any is within
/// reach.
///
/// Bones are first sieved by their posed extent -- centroid carried by the current matrix, half
/// the bounding diagonal at the body's scale, a controller's width of margin -- and only the
/// survivors have their vertices carried into the room and measured, which is a few thousand
/// points at most. Bones with no pose cannot be grabbed, since there is nothing behind them to
/// pull. The nearest vertex stands in for the nearest surface point: the meshes are dense enough
/// that the difference is under a millimetre.
fn nearest_surface(
    pack: &crate::pack::Pack,
    matrices: &[[f32; 16]],
    pose_index: &[Option<usize>],
    dataset_scale: f32,
    hand: [f32; 3],
) -> Option<(usize, usize, [f32; 3])> {
    const REACH: f32 = 0.05;
    let mut best: Option<(f32, usize, usize, [f32; 3])> = None;
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
        if distance - radius > REACH {
            continue;
        }
        // Inside the sieve: measure the surface itself.
        for vertex in pack.bones[i].vertices.chunks_exact(6) {
            let p = [
                m[0] * vertex[0] + m[4] * vertex[1] + m[8] * vertex[2] + m[12],
                m[1] * vertex[0] + m[5] * vertex[1] + m[9] * vertex[2] + m[13],
                m[2] * vertex[0] + m[6] * vertex[1] + m[10] * vertex[2] + m[14],
            ];
            let d = ((hand[0] - p[0]).powi(2) + (hand[1] - p[1]).powi(2) + (hand[2] - p[2]).powi(2)).sqrt();
            if d <= REACH && best.map(|(o, _, _, _)| d < o).unwrap_or(true) {
                best = Some((d, i, pose_bone, p));
            }
        }
    }
    best.map(|(_, i, j, p)| (i, j, p))
}

/// The tracked controllers as OpenXR actions: a grip pose, an aim pose, a squeeze and a trigger,
/// per hand. The grip is where the cube is drawn and the squeeze grabs; the aim is the ray that
/// points at the panel and the trigger presses what it points at.
struct Hands {
    set: openxr::ActionSet,
    #[allow(dead_code)]
    grip: openxr::Action<openxr::Posef>,
    #[allow(dead_code)]
    aim: openxr::Action<openxr::Posef>,
    squeeze: openxr::Action<bool>,
    /// Analogue, not a click: the click a runtime derives from a half-pulled trigger flickers
    /// across its threshold, and every flicker was a release and a press to the panel.
    trigger: openxr::Action<f32>,
    thumbstick: openxr::Action<openxr::Vector2f>,
    paths: [openxr::Path; crate::bridge::HANDS],
    grip_spaces: Vec<openxr::Space>,
    aim_spaces: Vec<openxr::Space>,
}

impl Hands {
    fn new(xr: &openxr::Instance, session: &openxr::Session<openxr::Vulkan>) -> Result<Self> {
        let paths = [
            xr.string_to_path("/user/hand/left")?,
            xr.string_to_path("/user/hand/right")?,
        ];
        let set = xr.create_action_set("hands", "Hands", 0)?;
        let grip = set.create_action::<openxr::Posef>("grip", "Grip pose", &paths)?;
        let aim = set.create_action::<openxr::Posef>("aim", "Aim pose", &paths)?;
        let squeeze = set.create_action::<bool>("grab", "Grab", &paths)?;
        let trigger = set.create_action::<f32>("point", "Press", &paths)?;
        let thumbstick = set.create_action::<openxr::Vector2f>("move", "Move", &paths)?;
        // Suggested per profile; the runtime picks the profile for the controller in hand. The
        // Index binds the squeeze to the grip sensor and the press to the trigger; the simple
        // profile has only a select, which is both.
        let suggest = |profile: &str, squeeze_input: &str, trigger_input: &str, stick: bool| -> Result<()> {
            let mut bindings = Vec::new();
            for side in ["left", "right"] {
                if stick {
                    bindings.push(openxr::Binding::new(
                        &thumbstick,
                        xr.string_to_path(&format!("/user/hand/{side}/input/thumbstick"))?,
                    ));
                }
                bindings.push(openxr::Binding::new(
                    &grip,
                    xr.string_to_path(&format!("/user/hand/{side}/input/grip/pose"))?,
                ));
                bindings.push(openxr::Binding::new(
                    &aim,
                    xr.string_to_path(&format!("/user/hand/{side}/input/aim/pose"))?,
                ));
                bindings.push(openxr::Binding::new(
                    &squeeze,
                    xr.string_to_path(&format!("/user/hand/{side}/input/{squeeze_input}"))?,
                ));
                bindings.push(openxr::Binding::new(
                    &trigger,
                    xr.string_to_path(&format!("/user/hand/{side}/input/{trigger_input}"))?,
                ));
            }
            xr.suggest_interaction_profile_bindings(xr.string_to_path(profile)?, &bindings)?;
            Ok(())
        };
        suggest("/interaction_profiles/valve/index_controller", "squeeze/value", "trigger/value", true)?;
        if let Err(e) = suggest("/interaction_profiles/khr/simple_controller", "select/click", "select/click", false) {
            println!("hands: the simple controller profile was refused ({e}); Index only");
        }
        session.attach_action_sets(&[&set])?;
        let grip_spaces = paths
            .iter()
            .map(|&path| grip.create_space(session, path, openxr::Posef::IDENTITY))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let aim_spaces = paths
            .iter()
            .map(|&path| aim.create_space(session, path, openxr::Posef::IDENTITY))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(Self {
            set,
            grip,
            aim,
            squeeze,
            trigger,
            thumbstick,
            paths,
            grip_spaces,
            aim_spaces,
        })
    }

    fn sync(&self, session: &openxr::Session<openxr::Vulkan>) -> Result<()> {
        session.sync_actions(&[openxr::ActiveActionSet::new(&self.set)])?;
        Ok(())
    }

    /// Where one of a hand's spaces is in `base` at `time`, if the runtime can say.
    fn locate(
        &self,
        space: &openxr::Space,
        base: &openxr::Space,
        time: openxr::Time,
    ) -> Result<Option<([f32; 3], [f32; 4])>> {
        let located = space.locate(base, time)?;
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

    /// The thumbstick, x right and y forward, each -1..1; zero when the controller has none.
    fn thumbstick(&self, session: &openxr::Session<openxr::Vulkan>, hand: usize) -> Result<[f32; 2]> {
        let state = self.thumbstick.state(session, self.paths[hand])?;
        Ok(if state.is_active {
            [state.current_state.x, state.current_state.y]
        } else {
            [0.0, 0.0]
        })
    }

    /// How far the trigger is pulled, 0..1; a boolean binding reads as 0 or 1.
    fn trigger(&self, session: &openxr::Session<openxr::Vulkan>, hand: usize) -> Result<f32> {
        let state = self.trigger.state(session, self.paths[hand])?;
        Ok(if state.is_active { state.current_state } else { 0.0 })
    }
}

/// Begin a session and run the frame loop for a while, submitting no layers.
///
/// `xrEndFrame` accepts a frame with no layers, which is what makes this worth doing: it exercises
/// `xrWaitFrame`, the session state machine and head tracking without needing a single correct
/// pipeline. If this holds the headset's rate and reports sensible poses, everything left is
/// ordinary Vulkan.
pub fn run_session(seconds: f32) -> Result<()> {
    let (_entry, xr, system) = bring_up()?;
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

    let stage = session
        .create_reference_space(openxr::ReferenceSpaceType::STAGE, openxr::Posef::IDENTITY)
        .context("asking the OpenXR runtime for the room's floor (the stage space)")?;

    let mut event_storage = openxr::EventDataBuffer::new();
    let mut running = false;
    let mut frames = 0u32;
    let started = std::time::Instant::now();
    let mut first_display: Option<openxr::Time> = None;
    let mut last_display = openxr::Time::from_nanos(0);

    while started.elapsed().as_secs_f32() < seconds {
        if pump_events(&xr, &session, &mut event_storage, &mut running)? == Flow::Exit {
            return Ok(());
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

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: [f32; 3], b: [f32; 3]) -> bool {
        (0..3).all(|i| (a[i] - b[i]).abs() < 1e-4)
    }

    #[test]
    fn a_turn_to_the_right_swings_the_world_to_the_left() {
        // A quarter turn to the right, standing at the stage's middle: what was straight ahead
        // is now off to the left, which is what a viewer who turned right would see.
        let mut v = Viewpoint::default();
        v.turn(std::f32::consts::FRAC_PI_2, [0.0, 1.6, 0.0]);
        let ahead = v.to_stage([0.0, 0.0, -2.0]);
        assert!(close(ahead, [-2.0, 0.0, 0.0]), "{ahead:?}");
    }

    #[test]
    fn a_turn_is_about_the_head_and_not_the_middle_of_the_stage() {
        // The head is a metre off the stage's middle; the world under it stays under it.
        let head = [1.0, 1.6, 0.0];
        let mut v = Viewpoint { offset: [3.0, 0.0, -2.0], yaw: 0.4 };
        let under = v.to_world(head);
        v.turn(0.9, head);
        assert!(close(v.to_world(head), under), "{:?}", v.to_world(head));
    }

    #[test]
    fn the_stage_and_the_world_are_each_other_undone() {
        let v = Viewpoint { offset: [1.5, 0.25, -3.0], yaw: -1.1 };
        let p = [0.3, 1.2, -0.8];
        assert!(close(v.to_world(v.to_stage(p)), p));
        assert!(close(v.to_stage(v.to_world(p)), p));
    }

    #[test]
    fn what_is_drawn_is_what_the_stage_says() {
        // The shift matrix and `to_stage` are the same transform; the draw and the grab must not
        // disagree about where the world is.
        let v = Viewpoint { offset: [-0.7, 1.0, 2.5], yaw: 0.8 };
        let p = [2.0, 0.5, -1.25];
        let m = v.shift();
        let drawn = [
            m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        ];
        assert!(close(drawn, v.to_stage(p)), "{drawn:?} vs {:?}", v.to_stage(p));
    }

    #[test]
    fn rising_lifts_the_viewer_rather_than_the_world() {
        // The stick pushed forward raises the offset, and the world is then drawn lower down.
        let v = Viewpoint { offset: [0.0, 1.5, 0.0], yaw: 0.0 };
        assert!(close(v.to_stage([0.0, 0.0, 0.0]), [0.0, -1.5, 0.0]));
    }

    fn secs(s: f64) -> Option<std::time::Duration> {
        Some(std::time::Duration::from_secs_f64(s))
    }

    #[test]
    fn a_paused_run_with_a_fresh_status_is_nothing_to_warn_about() {
        assert_eq!(liveness(secs(0.1), secs(30.0), true), None);
    }

    #[test]
    fn a_status_four_seconds_old_is_a_silent_publisher() {
        assert_eq!(liveness(secs(4.0), secs(4.0), false), Some(Liveness::Silent(4)));
        // Paused or not: a publisher that has stopped writing will not read a press either.
        assert_eq!(liveness(secs(4.0), None, true), Some(Liveness::Silent(4)));
    }

    #[test]
    fn a_fresh_status_over_a_pose_two_seconds_old_is_a_simulation_not_advancing() {
        assert_eq!(liveness(secs(0.1), secs(2.0), false), Some(Liveness::NotAdvancing));
    }

    #[test]
    fn the_showcase_between_episodes_is_not_a_warning() {
        // Status and poses stop together for 1.2 s. The status is noticed up to a poll after the
        // last pose, and neither reading is a warning.
        assert_eq!(liveness(secs(1.3), secs(1.3), false), None);
        assert_eq!(liveness(secs(1.1), secs(1.2), false), None);
        assert_eq!(liveness(secs(0.95), secs(1.05), false), None);
        // No status yet, or no feeds yet: nothing to measure against.
        assert_eq!(liveness(None, secs(9.0), false), None);
        assert_eq!(liveness(secs(0.1), None, false), None);
    }

    fn reading(text: &str) -> std::io::Result<(Option<std::time::SystemTime>, String)> {
        Ok((None, text.to_string()))
    }

    const STATUS: &str = r#"{"generation":1,"scenario":{"id":"a","title":"A"},"scenarios":[],
        "profile":"l1_standard","simSeconds":0,"speed":1,"paused":false,"muscles":false,
        "holding":[],"grabStrength":1,"wallSeconds":1.0}"#;

    #[test]
    fn a_status_is_seen_when_it_changes_and_not_when_it_is_read_again() {
        let mut feed = StatusFeed::default();
        let start = std::time::Instant::now();
        feed.observe(reading(STATUS), start);
        assert!(feed.status.is_some() && feed.error.is_none());
        assert_eq!(feed.seen, Some(start));
        // The same text again is a publisher that has not written since.
        let later = start + std::time::Duration::from_millis(100);
        feed.observe(reading(STATUS), later);
        assert_eq!(feed.seen, Some(start));
        // A new write moves it.
        let next = STATUS.replace("\"wallSeconds\":1.0", "\"wallSeconds\":1.1");
        feed.observe(reading(&next), later);
        assert_eq!(feed.seen, Some(later));
    }

    #[test]
    fn an_unreadable_status_is_said_rather_than_hidden_behind_the_last_good_one() {
        let mut feed = StatusFeed::default();
        let at = std::time::Instant::now();
        feed.observe(reading(STATUS), at);
        feed.observe(reading(&STATUS.replace("\"generation\":1", "\"generation\":null")), at);
        let why = feed.error.clone().expect("the error is kept");
        assert!(why.contains("null"), "{why}");
        assert!(feed.status.is_some(), "the last good status stays for the panels to show");
        // Readable again: the error goes.
        feed.observe(reading(&STATUS.replace("1.0", "2.0")), at);
        assert!(feed.error.is_none());
        // Gone: nothing to show and nothing wrong, and no age to warn about.
        feed.observe(Err(std::io::ErrorKind::NotFound.into()), at);
        assert!(feed.status.is_none() && feed.error.is_none() && feed.age().is_none());
    }

    #[test]
    fn a_stick_starts_from_nothing_once_it_is_past_its_dead_zone() {
        assert_eq!(past_dead_zone(0.1, 0.15), 0.0);
        assert_eq!(past_dead_zone(-0.15, 0.15), 0.0);
        assert!((past_dead_zone(0.15 + 1e-6, 0.15)).abs() < 1e-5);
        assert!((past_dead_zone(1.0, 0.15) - 1.0).abs() < 1e-6);
        assert!((past_dead_zone(-1.0, 0.15) + 1.0).abs() < 1e-6);
    }
}
