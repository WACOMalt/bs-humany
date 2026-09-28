//! OpenXR: bringing the runtime up, and the frame loop that draws the body in the room.
//!
//! Bringing up is arranged to fail in useful places rather than in one lump at the end, each
//! step saying what it found before the next is attempted -- which is what `probe` and `session`
//! are for:
//!
//!   1. **Instance.** Does a loader exist, which runtime answers, what extensions does it offer?
//!      Needs no hardware. Runs on a machine with nothing plugged in.
//!   2. **System and views.** Is there a head-mounted display, and what does it want rendered --
//!      how many views, at what resolution, at what rates? Needs the runtime to see a headset.
//!   3. **Session.** Begin a session and run the frame loop. `session` submits *no layers*, which
//!      `xrEndFrame` permits, so it proves the timing and tracking path with no rendering in it.
//!
//! A session needs a Vulkan device, because OpenXR will only create one against a graphics
//! binding and will only accept an instance and device built to its requirements. That is why
//! this crate uses `ash` rather than a portability layer: the requirements come from the runtime
//! and have to be obeyed literally.
//!
//! `view` is the frame loop the studio's headset runs. Each frame it waits on the runtime, locates
//! the eyes at the predicted display time, and then, never waiting on the publisher (ADR-012):
//! polls the publisher's status ten times a second by the clock, reopening the bridges when its
//! generation moves or its files are replaced; takes the newest pose and belly rings if they are
//! newer than the ones applied, and otherwise draws what it has; moves the viewer by the sticks
//! (or scrolls the panel a stick's ray is on) and recentres on a stick click; locates the hands,
//! aims their rays at the panels, and turns squeezes into grabs written to the grab channel and
//! trigger presses into panel presses and carries; lays out both panels and appends what was
//! pressed to the command log; and draws bones, muscles, tissue, scenery, grid, hands, rays and
//! panels in one multiview pass for both eyes. Every way out of drawing lets go of whatever the
//! hands held first, so the simulation never reads a squeeze that has stopped.
//!
//! What the loop keeps between frames is a `ViewerState`, and a frame is its steps in that order:
//! `poll_publisher`, `apply_newest_pose`, `locomote`, `hands_and_panels` (whose grab intents are
//! then written) and `submit`. What those steps call on lives beside this file: `follow.rs` for
//! the publisher's feeds and status, `locomotion.rs` for the sticks and the recentre, `input.rs`
//! for the controllers and what their rays and triggers do to the panels, `grab.rs` for what a
//! squeeze takes hold of, and `render.rs` for the drawing.

use anyhow::{Context, Result, bail};
use ash::vk::{self, Handle};
use std::ffi::{CStr, CString};

use crate::follow::{
    Feeds, STATUS_POLL, SaidLiveness, StatusFeed, liveness, read_status_file, reopen_commands,
};
use crate::grab::{Hold, let_go_of_everything, nearest_surface};
use crate::input::{Aim, FIRM_TICK, Hands, PRESS_TICK, PressOn, aim};
use crate::locomotion::{
    DEAD_ZONE, LIFT_SPEED, TURN_SPEED, Viewpoint, WALK_SPEED, home_placements, past_dead_zone, recentre,
    snap_turn, stick_on_panel,
};
use crate::panel::Placement;

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
    // The HP Reverb's controllers have an interaction profile of their own, which a runtime only
    // accepts bindings for when this extension is asked for. Asked for only when offered: an
    // instance asking for an extension its runtime lacks is refused outright, and a runtime
    // without it has no HP controllers to bind anyway.
    wanted.ext_hp_mixed_reality_controller = available.ext_hp_mixed_reality_controller;
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
///
/// `profiles_changed` is set when the runtime says the controllers in hand have changed profile
/// -- which it also says once at the start, when it first settles on one -- so that `view` can
/// ask which, say so and show it. `session`, which binds no controllers, ignores it.
fn pump_events(
    xr: &openxr::Instance,
    session: &openxr::Session<openxr::Vulkan>,
    storage: &mut openxr::EventDataBuffer,
    running: &mut bool,
    profiles_changed: &mut bool,
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
            InteractionProfileChanged(_) => *profiles_changed = true,
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
                std::mem::transmute::<vk::PFN_vkGetInstanceProcAddr, openxr::sys::platform::VkGetInstanceProcAddr>(
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
                std::mem::transmute::<vk::PFN_vkGetInstanceProcAddr, openxr::sys::platform::VkGetInstanceProcAddr>(
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

/// Begin a session, build the renderer and draw the body until told to stop: posed by the
/// publisher at `follow` when there is one, the rest pose until it appears or when there is none.
///
/// The frame loop takes the head pose the runtime predicts for *this* frame and draws from the
/// pose buffer as it stands, never waiting for anything upstream -- ADR-012. A slow simulation is
/// therefore a slow body in a view that is still tracked at the headset's rate, rather than a
/// headset stalling on a slow tick.
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
        .map(ash::vk::Image::from_raw)
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

    // Everything the loop keeps from one frame to the next; the publisher's feeds are opened here
    // if it is already there.
    let mut viewer = ViewerState::new(pack, follow, &mut renderer)?;

    let stage = session
        .create_reference_space(openxr::ReferenceSpaceType::STAGE, openxr::Posef::IDENTITY)
        .context("asking the OpenXR runtime for the room's floor (the stage space)")?;
    let mut event_storage = openxr::EventDataBuffer::new();
    let mut running = false;
    let started = std::time::Instant::now();

    while started.elapsed().as_secs_f32() < seconds {
        let flow = pump_events(&xr, &session, &mut event_storage, &mut running, &mut viewer.profiles_changed)?;
        // The controllers in hand changed, or the runtime has settled on them for the first time:
        // which they are is said once, on the terminal and on the panels, where somebody holding
        // a controller the guide was not written for can see what the runtime made of it.
        if viewer.profiles_changed && flow == Flow::Continue {
            viewer.profiles_changed = false;
            viewer.headset.profiles = hands.profiles(&xr, &session);
            for (side, profile) in ["left", "right"].iter().zip(&viewer.headset.profiles) {
                println!("hands: {side} uses {profile}");
            }
        }
        if flow == Flow::Exit {
            viewer.let_go("the session is over");
            // Nothing is destroyed while the GPU may still be drawing into it.
            renderer.wait_idle();
            return Ok(());
        }
        if !running {
            if viewer.drawing {
                viewer.drawing = false;
                viewer.let_go("the session stopped");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
            continue;
        }

        let state = frame_wait.wait()?;
        frame_stream.begin()?;
        if !state.should_render {
            if viewer.drawing {
                viewer.drawing = false;
                viewer.let_go("nothing is being drawn");
            }
            frame_stream.end(
                state.predicted_display_time,
                openxr::EnvironmentBlendMode::OPAQUE,
                &[],
            )?;
            continue;
        }
        viewer.drawing = true;

        let cpu_started = std::time::Instant::now();
        let (_flags, views) = session.locate_views(
            openxr::ViewConfigurationType::PRIMARY_STEREO,
            state.predicted_display_time,
            &stage,
        )?;

        viewer.poll_publisher(pack, follow, &mut renderer)?;
        viewer.apply_newest_pose();
        hands.sync(&session)?;
        let moved = viewer.locomote(&hands, &session, &views)?;
        let frame = viewer.hands_and_panels(
            pack,
            follow,
            &hands,
            &session,
            &stage,
            state.predicted_display_time,
            &moved,
            &mut renderer,
        )?;
        viewer.publish_grabs(&frame.grabs);
        viewer.submit(
            &mut swapchain,
            &mut frame_stream,
            &renderer,
            &stage,
            &views,
            state.predicted_display_time,
            extent,
            &frame,
            cpu_started,
        )?;
    }

    viewer.let_go("the viewer is done");
    renderer.wait_idle();
    println!(
        "{} frames in {:.1} s -- {:.1} Hz, worst CPU frame {:.2} ms",
        viewer.frames,
        started.elapsed().as_secs_f32(),
        viewer.frames as f32 / started.elapsed().as_secs_f32(),
        viewer.worst_cpu
    );
    Ok(())
}

/// Everything the frame loop keeps from one frame to the next, and the per-frame steps that read
/// and change it, in the order `view` calls them: `poll_publisher`, `apply_newest_pose`,
/// `locomote`, `hands_and_panels` and `submit`. None of them waits on the publisher (ADR-012).
struct ViewerState {
    /// Where the body stands: the simulation's ground lifted to the stage floor. Known once the
    /// status says the ground's height; zero, which is nearly every scenario, until then.
    ground: f32,
    place: [f32; 16],
    /// Bones, the two controllers, the world slot at the placement, a pointer mark a hand, the
    /// grid at the identity, the scenery at the placement, and an aim ray a hand; `Slots` says
    /// where each is.
    slots: crate::render::Slots,
    matrices: Vec<[f32; 16]>,

    /// What is followed: the pose bridge, the muscles beside it, the grab channel back. Opened
    /// together, and reopened together whenever the publisher's generation changes, which is how
    /// a scenario switch reaches this side, or the files at their names are not the ones mapped,
    /// which is how a publisher that restarted from the same generation does.
    /// Opened at the start if the publisher is already there; otherwise the loop keeps trying
    /// every status poll, drawing the rest pose meanwhile, because "viewer first, then the run" is
    /// a perfectly good order to do things in and the studio's Connect button does exactly that.
    feeds: Option<Feeds>,
    status_path: Option<std::path::PathBuf>,
    publisher: StatusFeed,
    said: SaidLiveness,
    commands: Option<crate::bridge::CommandWriter>,
    holding: [Option<Hold>; crate::bridge::HANDS],
    hand_seen: [bool; crate::bridge::HANDS],
    /// Where each hand's press began, from the trigger going down until it is let go. It decides
    /// everything the press does: begun on a panel's face, that panel keeps the hand as its
    /// pointer wherever the ray goes, so a slider dragged off the end still lands and the drag
    /// never slides onto a strip and picks the panel up; begun on a strip, it carries the panel;
    /// begun anywhere else, it presses nothing at all. The last is what the trigger was once
    /// "armed" for: squeezing to grab a bone tends to pull the trigger too, and the ray sweeping
    /// the panel then was clicking whatever it crossed.
    press_on: [Option<PressOn>; crate::bridge::HANDS],
    /// Which panel's face each hand's ray was on last frame. That hand's stick scrolls the panel
    /// instead of moving the viewer; last frame's, because the sticks are read before the rays.
    on_face: [Option<usize>; crate::bridge::HANDS],
    /// Pressed past six tenths, released under a quarter: a trigger held anywhere between stays
    /// what it was, so a hand resting on the trigger does not click.
    trigger_down: [bool; crate::bridge::HANDS],
    scene_generation: Option<u64>,
    /// Moving about: the sticks carry the viewer through the world, which is to say the world is
    /// moved the other way under a stage that does not move. `view_point` is where the stage
    /// origin sits in the world and how far the world is turned about the viewer; everything of
    /// the world is drawn through `shift`, and the hands, which are of the stage, are not.
    view_point: Viewpoint,
    last_frame: std::time::Instant,
    muscle_vertices: Vec<f32>,
    tissue_vertices: Vec<f32>,
    /// The connective tissue's fixed shape, rebuilt when the publisher's generation changes.
    tissue_shape: Option<crate::tissue::TissueShape>,
    tissue_generation: Option<u64>,
    last_tick: Option<u64>,
    last_muscle_tick: Option<u64>,

    /// The panels: the properties panel to the viewer's right of the body, a little below eye
    /// height, and the transport strip under it, both turned to face where the viewer stands --
    /// `home_placements`, which a recentre puts them back to. Whichever hand is pointing at a
    /// panel is its pointer; a hand that pressed on it keeps being the pointer until it lets go, so
    /// a drag does not change hands mid-way. A hand on a grab strip carries the panel instead.
    /// Where they overlap, the nearer is the one pointed at.
    placements: [Placement; 2],
    panels: [crate::panel::Panel; 2],
    pointer_hand: [Option<usize>; 2],
    carrying: [Option<(usize, crate::panel::Held)>; crate::bridge::HANDS],
    /// What the viewer knows of itself for the panels to show: which controllers are in hand, and
    /// whether the right stick turns in steps. Smooth turning is the default; snap turn is a box on
    /// the transport strip for whoever the smooth turn makes queasy.
    headset: crate::panel::Headset,
    profiles_changed: bool,
    /// Whether a snap turn is armed: the stick has come back to the middle since the last step.
    snap_armed: bool,

    frames: u32,
    last_poll: Option<std::time::Instant>,
    worst_cpu: f64,
    /// Reported as it goes rather than only at the end, because the natural way to stop watching
    /// something in a headset is to take it off and press Ctrl-C, and a summary that only prints
    /// on a clean exit is a summary nobody ever sees.
    window_started: std::time::Instant,
    window_frames: u32,
    window_worst: f64,
    /// Whether the last frame was drawn, which is whether the hands were last written. The slots
    /// are only rewritten on a frame that is drawn, so every way out of drawing -- the session
    /// stopping, the runtime saying not to render, the session or the loop ending -- first
    /// writes both hands open: the simulation would otherwise read the last squeeze for as long
    /// as the file stands. Its readers keep a watch on the write count as well, which is what
    /// covers a viewer that is killed and never gets to say so.
    drawing: bool,
}

/// What this frame's sticks did, for the hands and the panels after them: the time since the last
/// frame, where the head is in the stage, the matrix everything of the world is drawn through, and
/// how far each panel is scrolled.
#[derive(Clone, Copy)]
struct Moved {
    dt: f32,
    head: [f32; 3],
    shift: [f32; 16],
    scroll: [f32; 2],
}

/// What the hands and the panels made of this frame: a grab intent for each hand that has a
/// publisher's grab channel to write it to; every slot's matrix as it is drawn; each panel's
/// meshes, and the panels in the order to draw them with the matrix each is drawn by; and whether
/// the muscles and the tissue are shown.
struct HandsAndPanels {
    grabs: [Option<crate::bridge::GrabIntent>; crate::bridge::HANDS],
    drawn: Vec<[f32; 16]>,
    meshes: [Vec<crate::panel::Mesh>; 2],
    order: [(usize, [f32; 16]); 2],
    show_muscles: bool,
    show_tissue: bool,
}

impl HandsAndPanels {
    /// The panels as `draw` wants them, in the order they are to be drawn.
    fn panel_draws(&self) -> Vec<crate::render::PanelDraw<'_>> {
        self.order
            .iter()
            .map(|(which, model)| crate::render::PanelDraw {
                model: *model,
                meshes: &self.meshes[*which],
            })
            .collect()
    }
}

impl ViewerState {
    /// The state before the first frame: the rest pose at the placement, the marks and rays
    /// hidden, the panels at home, and the publisher's feeds and command log opened when
    /// `follow` names one.
    fn new(
        pack: &crate::pack::Pack,
        follow: Option<&std::path::Path>,
        renderer: &mut crate::render::Renderer,
    ) -> Result<Self> {
        use crate::panel::{Kind, Panel};
        let ground = 0.0f32;
        let place = crate::math::placement(ground);
        let slots = renderer.slots();
        let mut matrices: Vec<[f32; 16]> = vec![place; slots.total];
        // The marks and the rays are nothing until a hand points.
        for hand in 0..crate::render::MARKERS {
            matrices[slots.marker(hand)] = crate::math::scale_matrix(0.0);
        }
        for hand in 0..crate::render::RAYS {
            matrices[slots.ray(hand)] = crate::math::scale_matrix(0.0);
        }
        // The grid is the stage itself: the identity.
        matrices[slots.stage] = crate::math::scale_matrix(1.0);

        let feeds = match follow {
            Some(path) => match Feeds::open(path, pack, renderer) {
                Ok(f) => Some(f),
                Err(e) => {
                    println!("waiting for a publisher at {}: {e}", path.display());
                    None
                }
            },
            None => None,
        };
        let status_path = follow.map(|p| std::path::PathBuf::from(format!("{}-status.json", p.display())));
        let commands = match follow {
            Some(path) => Some(crate::bridge::CommandWriter::create(&std::path::PathBuf::from(
                format!("{}-commands.jsonl", path.display()),
            ))?),
            None => None,
        };
        Ok(Self {
            ground,
            place,
            slots,
            matrices,
            feeds,
            status_path,
            publisher: StatusFeed::default(),
            said: SaidLiveness::Fine,
            commands,
            holding: [None, None],
            hand_seen: [false; crate::bridge::HANDS],
            press_on: [None, None],
            on_face: [None, None],
            trigger_down: [false; crate::bridge::HANDS],
            scene_generation: None,
            view_point: Viewpoint::default(),
            last_frame: std::time::Instant::now(),
            muscle_vertices: Vec::new(),
            tissue_vertices: Vec::new(),
            tissue_shape: None,
            tissue_generation: None,
            last_tick: None,
            last_muscle_tick: None,
            placements: home_placements([0.0, 0.0, 0.0], [0.0, 0.0, -1.0]),
            panels: [Panel::new(Kind::Properties), Panel::new(Kind::Transport)],
            pointer_hand: [None, None],
            carrying: [None, None],
            headset: crate::panel::Headset::default(),
            profiles_changed: false,
            snap_armed: true,
            frames: 0,
            last_poll: None,
            worst_cpu: 0.0,
            window_started: std::time::Instant::now(),
            window_frames: 0,
            window_worst: 0.0,
            drawing: false,
        })
    }

    /// Both hands open, on both sides of the grab channel: `let_go_of_everything`, said with why.
    fn let_go(&mut self, why: &str) {
        let_go_of_everything(self.feeds.as_mut().map(|f| &mut f.grabs), &mut self.holding, why);
    }

    /// The publisher's status, ten times a second by the clock rather than by the frame, so a
    /// 144 Hz headset and a 90 Hz one poll at the rate every publisher writes; and the feeds
    /// reopened if its generation moved or its files were replaced. A publisher that has not
    /// written a status yet, or that has stopped and removed it, is simply not there this
    /// poll. None of this waits on the publisher: a stat and a read of a small file on tmpfs.
    fn poll_publisher(
        &mut self,
        pack: &crate::pack::Pack,
        follow: Option<&std::path::Path>,
        renderer: &mut crate::render::Renderer,
    ) -> Result<()> {
        if self.last_poll.map_or(true, |at| at.elapsed() >= STATUS_POLL) {
            self.last_poll = Some(std::time::Instant::now());
            if let (None, Some(follow_path)) = (self.feeds.as_ref(), follow) {
                if let Ok(opened) = Feeds::open(follow_path, pack, renderer) {
                    self.feeds = Some(opened);
                    self.last_tick = None;
                    self.last_muscle_tick = None;
                    self.muscle_vertices.clear();
                    reopen_commands(&mut self.commands);
                }
            }
            if let Some(path) = &self.status_path {
                self.publisher.observe(read_status_file(path), std::time::Instant::now());
            }
            if let (Some(f), Some(follow_path)) = (self.feeds.as_ref(), follow) {
                // The generation is only trusted from a status that read cleanly: the feeds
                // take theirs from the file when they open, and one that did not parse then
                // would disagree with the last good status at every poll. The files' identity
                // needs no status at all.
                let why = match self.publisher.status.as_ref() {
                    Some(s) if self.publisher.error.is_none() && s.generation != f.generation => {
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
                    match Feeds::open(follow_path, pack, renderer) {
                        Ok(reopened) => {
                            self.feeds = Some(reopened);
                            self.holding = [None, None];
                            self.last_tick = None;
                            self.last_muscle_tick = None;
                            self.muscle_vertices.clear();
                            // A publisher that restarted may have kept its generation, so the
                            // scene and the tissue are taken again from whatever it says next,
                            // rather than only when the number moves.
                            self.scene_generation = None;
                            self.tissue_generation = None;
                            reopen_commands(&mut self.commands);
                        }
                        Err(e) => println!("publisher: could not reopen yet: {e}"),
                    }
                }
            }
            // The scenery, once a generation. `set_scene` waits for the device to idle and
            // reallocates, so it is never called on a poll that changed nothing.
            if let Some(s) = self.publisher.status.as_ref() {
                if self.scene_generation != Some(s.generation) {
                    self.scene_generation = Some(s.generation);
                    self.ground = s.ground_height as f32;
                    self.place = crate::math::placement(self.ground);
                    self.matrices[self.slots.world] = self.place;
                    self.matrices[self.slots.scene] = self.place;
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
            if let (Some(f), Some(s)) = (self.feeds.as_ref(), self.publisher.status.as_ref()) {
                let table_arrived = self.tissue_shape.is_none() && !s.tissue.discs.is_empty();
                if self.tissue_generation != Some(f.generation) || table_arrived {
                    self.tissue_generation = Some(f.generation);
                    let shape = crate::tissue::TissueShape::new(&s.tissue, &f.bridge.names);
                    renderer.enable_tissue(&shape.indices, shape.vertex_count * 7)?;
                    self.tissue_vertices.clear();
                    if shape.is_empty() {
                        self.tissue_shape = None;
                    } else {
                        println!(
                            "tissue: {} discs and beads, {} bars",
                            s.tissue.discs.len(),
                            s.tissue.bars.len()
                        );
                        self.tissue_shape = Some(shape);
                    }
                }
            }
        }
        Ok(())
    }

    /// The newest pose, if there is one and it is newer than the one already applied, into the
    /// bones' matrices and the tissue; and the newest belly rings swept into the muscle tubes. Per
    /// ADR-012 this never waits: no frame yet, or one mid-write, means the matrices stand.
    fn apply_newest_pose(&mut self) {
        if let Some(f) = self.feeds.as_mut() {
            if let Some(frame) = f.bridge.newest() {
                if self.last_tick != Some(frame.tick) {
                    self.last_tick = Some(frame.tick);
                    let b = &f.bridge;
                    let scale = crate::math::scale_matrix(b.dataset_scale as f32);
                    for (i, found) in f.pose_index.iter().enumerate() {
                        self.matrices[i] = match found {
                            Some(j) => {
                                let p = &frame.pose[j * 7..j * 7 + 7];
                                let r = &b.rest[j * 7..j * 7 + 7];
                                // place * current * rest^-1 * scale: the studio's own skin, with
                                // the pack scaled to this body's stature on the way in.
                                let current =
                                    crate::math::pose_matrix([p[0], p[1], p[2]], [p[3], p[4], p[5], p[6]]);
                                let rest_inverse =
                                    crate::math::inverse_pose([r[0], r[1], r[2]], [r[3], r[4], r[5], r[6]]);
                                crate::math::multiply(
                                    &self.place,
                                    &crate::math::multiply(
                                        &current,
                                        &crate::math::multiply(&rest_inverse, &scale),
                                    ),
                                )
                            }
                            None => self.place,
                        };
                    }
                    if let Some(shape) = &self.tissue_shape {
                        shape.vertices(&frame.pose, &mut self.tissue_vertices);
                    }
                }
            }
            if let Some(m) = f.muscles.as_mut() {
                if let Some(frame) = m.newest() {
                    if self.last_muscle_tick != Some(frame.tick) {
                        self.last_muscle_tick = Some(frame.tick);
                        let tension: &[f32] =
                            self.publisher.status.as_ref().map(|s| s.tension.as_slice()).unwrap_or(&[]);
                        crate::geometry::tube_vertices(
                            &frame.rings,
                            m.rings,
                            m.segments,
                            self.slots.world as u32,
                            tension,
                            &mut self.muscle_vertices,
                        );
                    }
                }
            }
        }
    }

    /// The sticks, each either moving the viewer or, while its hand's ray is on a panel's face,
    /// scrolling that panel: the one stick cannot do both, and a person aiming at a long tab and
    /// pushing the stick wants the tab to move, not the room. And a stick pressed in recentres.
    fn locomote(
        &mut self,
        hands: &Hands,
        session: &openxr::Session<openxr::Vulkan>,
        views: &[openxr::View],
    ) -> Result<Moved> {
        let now = std::time::Instant::now();
        let dt = (now - self.last_frame).as_secs_f32().min(0.1);
        self.last_frame = now;
        let head = views[0].pose.position;
        let head = [head.x, head.y, head.z];
        // The stick pressed in, on either hand: back to the start, the panels in front. Before
        // anything this frame is aimed or carried, so all of it is in the recentred world.
        let mut recentred = false;
        for hand in 0..crate::bridge::HANDS {
            if hands.recentre_pressed(session, hand)? {
                recentred = true;
                hands.pulse(session, hand, FIRM_TICK);
            }
        }
        if recentred {
            for (which, _) in self.carrying.iter().flatten() {
                self.panels[*which].grabbed = false;
            }
            let q = views[0].pose.orientation;
            recentre(&mut self.view_point, &mut self.placements, &mut self.carrying, head, [q.x, q.y, q.z, q.w]);
            // A press under way was aimed through the world as it was; it presses nothing more,
            // and the trigger must be let go and pulled again to press on the panel that has
            // come to meet it.
            for press in self.press_on.iter_mut().filter(|p| p.is_some()) {
                *press = Some(PressOn::Air);
            }
            // So is a hold: its target is the hand carried into the world through the viewpoint,
            // and the world has just jumped, which would fling the body after it. A squeeze that
            // is still held takes hold afresh, where the bone now is.
            self.let_go("recentred");
            println!("view: recentred");
        }
        let mut scroll = [0.0f32; 2];
        let mut sticks = [[0.0f32; 2]; crate::bridge::HANDS];
        for (hand, stick) in sticks.iter_mut().enumerate() {
            let (moving, scrolling) = stick_on_panel(hands.thumbstick(session, hand)?, self.on_face[hand].is_some(), DEAD_ZONE);
            *stick = moving;
            if let Some(which) = self.on_face[hand] {
                scroll[which] = (scroll[which] + scrolling).clamp(-1.0, 1.0);
            }
        }
        // Walking: the left stick, in the frame of where the head is looking, flattened.
        let stick = sticks[0];
        let deflection = (stick[0] * stick[0] + stick[1] * stick[1]).sqrt();
        if deflection > DEAD_ZONE {
            let q = views[0].pose.orientation;
            let mut forward = crate::math::rotate([0.0, 0.0, -1.0], [q.x, q.y, q.z, q.w]);
            forward[1] = 0.0;
            let length = (forward[0] * forward[0] + forward[2] * forward[2]).sqrt().max(1e-6);
            forward = [forward[0] / length, 0.0, forward[2] / length];
            let right = [-forward[2], 0.0, forward[0]];
            let scale = WALK_SPEED * dt * ((deflection - DEAD_ZONE) / (1.0 - DEAD_ZONE)) / deflection;
            // The step is in the frame of the head, which is of the stage; it is spent on the
            // world, so it is turned there first.
            let step = self.view_point.to_world_direction([
                (right[0] * stick[0] + forward[0] * stick[1]) * scale,
                (right[1] * stick[0] + forward[1] * stick[1]) * scale,
                (right[2] * stick[0] + forward[2] * stick[1]) * scale,
            ]);
            for (offset, moved) in self.view_point.offset.iter_mut().zip(step) {
                *offset += moved;
            }
        }
        // Turning and rising: the right stick. Left and right turn the viewer about where the
        // head is, so it is a turn on the spot rather than a swing around the middle of the
        // stage -- smoothly, or in steps with snap turn on; forward and back lift and lower.
        // Each axis has its own dead zone, so a stick pushed to turn does not also drift upwards.
        let look = sticks[1];
        if self.headset.snap_turn {
            let by = snap_turn(look[0], &mut self.snap_armed);
            if by != 0.0 {
                self.view_point.turn(by, head);
            }
        } else {
            let turn = past_dead_zone(look[0], DEAD_ZONE);
            if turn != 0.0 {
                self.view_point.turn(turn * TURN_SPEED * dt, head);
            }
        }
        let lift = past_dead_zone(look[1], DEAD_ZONE);
        if lift != 0.0 {
            self.view_point.offset[1] += lift * LIFT_SPEED * dt;
        }
        let shift = self.view_point.shift();
        Ok(Moved { dt, head, shift, scroll })
    }

    /// The hands and the panels: where each hand is drawn, what its ray points at and its trigger
    /// presses or carries, what its squeeze grabs; then both panels laid out afresh, their
    /// textures applied before the draw that samples them and what was pressed sent on. The grab
    /// intents come back to be written, and the panels come back in the order to draw them.
    #[allow(clippy::too_many_arguments)]
    fn hands_and_panels(
        &mut self,
        pack: &crate::pack::Pack,
        follow: Option<&std::path::Path>,
        hands: &Hands,
        session: &openxr::Session<openxr::Vulkan>,
        stage: &openxr::Space,
        time: openxr::Time,
        moved: &Moved,
        renderer: &mut crate::render::Renderer,
    ) -> Result<HandsAndPanels> {
        let Moved { dt, head, shift, scroll } = *moved;
        let controller_scale = crate::math::scale_matrix(1.0);
        // The overlays as the studio has them; a publisher that says nothing shows everything.
        let overlay = |name: &str| {
            self.publisher
                .status
                .as_ref()
                .and_then(|s| s.overlays.get(name).copied())
                .unwrap_or(true)
        };
        // The tubes are the muscles' volumes, swept from the belly rings, so they follow that box
        // alone. Muscle paths are the desktop's origin-to-insertion lines, which nothing here
        // draws; following either box drew tubes for a desktop showing paths with volumes off.
        let show_muscles = overlay("muscleVolumes");
        let show_tissue = overlay("tissue");
        self.matrices[self.slots.stage] =
            crate::math::scale_matrix(if overlay("grid") { 1.0 } else { 0.0 });
        // What is drawn: the world's slots through the shift, the hands' slots as they are.
        let mut drawn = self.matrices.clone();
        for (slot, m) in drawn.iter_mut().enumerate() {
            if !self.slots.is_hand(slot) {
                *m = crate::math::multiply(&shift, &self.matrices[slot]);
            }
        }
        // The hands: located in the stage like the eyes, drawn as cubes at their grips, and asked
        // whether they are squeezing. A hand the runtime cannot place this frame keeps its last
        // cube and cannot begin a grab, but a grab already begun continues at the last target.
        let mut grabs: [Option<crate::bridge::GrabIntent>; crate::bridge::HANDS] = [None, None];
        let mut pointers = [crate::panel::Pointer::default(); 2];
        let mut pointer_candidate: [Option<(usize, egui::Pos2, bool)>; 2] = [None, None];
        for hand in 0..crate::bridge::HANDS {
            let slot = self.slots.controller(hand);
            let located = hands.locate(&hands.grip_spaces[hand], stage, time)?;
            if let Some((position, orientation)) = located {
                if !self.hand_seen[hand] {
                    self.hand_seen[hand] = true;
                    println!("hand {}: tracked", ["left", "right"][hand]);
                }
                drawn[slot] = crate::math::multiply(
                    &crate::math::pose_matrix(position, orientation),
                    &controller_scale,
                );
            }
            // Where the aim ray meets the panel, if it does: a mark there, and a candidate for
            // being the pointer.
            let marker = self.slots.marker(hand);
            drawn[marker] = crate::math::scale_matrix(0.0);
            let pull = hands.trigger(session, hand)?;
            let was_down = self.trigger_down[hand];
            self.trigger_down[hand] = if was_down { pull > 0.25 } else { pull > 0.6 };
            let pressed = self.trigger_down[hand];
            let aimed = hands.locate(&hands.aim_spaces[hand], stage, time)?;
            // The panels are of the world; the ray is of the stage. Carry the ray over, turn
            // and all: a viewer who has turned no longer points where the stage says.
            let ray = aimed.map(|(position, orientation)| {
                let q = self.view_point.to_world_rotation(orientation);
                (
                    self.view_point.to_world(position),
                    q,
                    crate::math::rotate([0.0, 0.0, -1.0], q),
                )
            });
            // How far the drawn ray reaches: to the mark where it meets a panel, or to the strip
            // of the panel it is carrying; to RAY_REACH when it meets nothing.
            let mut reach: Option<f32> = None;
            // A hand carrying a panel keeps carrying it while the trigger is down, wherever it
            // points; let go, the panel stays.
            self.on_face[hand] = None;
            if let Some((which, held)) = self.carrying[hand] {
                match ray {
                    Some((from, q, forward)) if pressed => {
                        self.placements[which] = self.placements[which].carried(&held, from, q);
                        reach = self.placements[which].hit(from, forward).map(|(t, _)| t);
                    }
                    Some(_) => {
                        self.carrying[hand] = None;
                        self.press_on[hand] = None;
                        self.panels[which].grabbed = false;
                        hands.pulse(session, hand, FIRM_TICK);
                        println!("hand {}: put the panel down", ["left", "right"][hand]);
                    }
                    None => {}
                }
            } else {
                // A hand that is holding a bone is busy; its ray is not a pointer.
                let busy = self.holding[hand].is_some();
                let pointing = ray.map(|(from, _, forward)| (from, forward));
                // A mark where the ray meets a panel, in the stage, and the ray drawn as far as
                // it. The distance is the same in the stage as in the world, which differ only by
                // a turn and a shift. Measured to the mark rather than along the ray: the two are
                // the same while the ray is on the face, and for a press held past a panel's
                // edge, whose mark waits at the edge, the ray still stops about the panel's
                // depth instead of running on through it.
                let mut mark = |which: usize, at: egui::Pos2| {
                    let in_stage = self.view_point.to_stage(self.placements[which].to_world(at));
                    if let Some((from, _)) = aimed {
                        reach = Some(distance(from, in_stage));
                    }
                    crate::math::pose_matrix(in_stage, [0.0, 0.0, 0.0, 1.0])
                };
                match aim(&self.placements, pointing, pressed, busy, &mut self.press_on[hand]) {
                    Aim::Face { which, at, pressing } => {
                        drawn[marker] = mark(which, at);
                        self.on_face[hand] = Some(which);
                        // A tick as a press lands on a face: the trigger's travel says nothing
                        // about whether the button under the mark took it.
                        if pressing && !was_down {
                            hands.pulse(session, hand, PRESS_TICK);
                        }
                        // The hand that pressed keeps the panel; otherwise the first hand on it,
                        // unless a later one is pressing and the first only pointing.
                        let keep = self.pointer_hand[which] == Some(hand);
                        let outranks = pointer_candidate[which].map_or(true, |(_, _, other)| pressing && !other);
                        if keep || outranks {
                            pointer_candidate[which] = Some((hand, at, pressing));
                        }
                    }
                    Aim::Strip { which, at, take } => {
                        drawn[marker] = mark(which, at);
                        let already_carried = self.carrying.iter().flatten().any(|(w, _)| *w == which);
                        if take && !already_carried {
                            if let Some((from, q, _)) = ray {
                                self.carrying[hand] = Some((which, self.placements[which].held_by(from, q)));
                                self.panels[which].grabbed = true;
                                hands.pulse(session, hand, FIRM_TICK);
                                println!("hand {}: took the panel", ["left", "right"][hand]);
                            }
                        }
                    }
                    Aim::Nothing => {}
                }
            }
            // The ray, from the aim pose in the stage, where the hands live. None for a hand the
            // runtime cannot aim this frame, and none for a hand holding a bone, which is not a
            // pointer and would only draw a line through the body it is holding.
            drawn[self.slots.ray(hand)] = match aimed {
                Some((position, orientation)) if self.holding[hand].is_none() => crate::geometry::ray_matrix(
                    position,
                    orientation,
                    reach.unwrap_or(crate::geometry::RAY_REACH),
                ),
                _ => crate::math::scale_matrix(0.0),
            };
            let Some(f) = self.feeds.as_ref() else { continue };
            let squeezing = hands.squeezing(session, hand)?;
            let intent = match (&self.holding[hand], squeezing, located) {
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
                            hands.pulse(session, hand, FIRM_TICK);
                            // A hand holding a bone draws no ray, from this frame on.
                            drawn[self.slots.ray(hand)] = crate::math::scale_matrix(0.0);
                            // The surface is in the stage; the simulation wants the world.
                            let point = crate::math::unplace(self.view_point.to_world(surface), self.ground);
                            self.holding[hand] = Some(Hold {
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
                                rotation: crate::math::unplace_rotation(
                                    self.view_point.to_world_rotation(hand_q),
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
                            let delta = crate::math::quaternion_multiply(
                                hand_q,
                                crate::math::quaternion_conjugate(hold.hand_q),
                            );
                            let carried = crate::math::rotate(hold.offset, delta);
                            (
                                crate::math::unplace(
                                    self.view_point.to_world([
                                        hand_at[0] + carried[0],
                                        hand_at[1] + carried[1],
                                        hand_at[2] + carried[2],
                                    ]),
                                    self.ground,
                                ),
                                crate::math::unplace_rotation(
                                    self.view_point.to_world_rotation(hand_q),
                                ),
                            )
                        }
                        None => (
                            hold.point,
                            crate::math::unplace_rotation(
                                self.view_point.to_world_rotation(hold.hand_q),
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
                    hands.pulse(session, hand, FIRM_TICK);
                    self.holding[hand] = None;
                    crate::bridge::GrabIntent::default()
                }
                _ => crate::bridge::GrabIntent::default(),
            };
            grabs[hand] = Some(intent);
        }
        for which in 0..2 {
            match pointer_candidate[which] {
                Some((hand, at, pressed)) => {
                    self.pointer_hand[which] = if pressed { Some(hand) } else { None };
                    pointers[which] = crate::panel::Pointer {
                        at: Some(at),
                        pressed,
                        scroll: scroll[which],
                    };
                }
                None => self.pointer_hand[which] = None,
            }
        }

        // How lively the publisher is: how long since the status last changed and since a new
        // pose arrived, which the panels say in numbers and, past a threshold, in words.
        let status_age = self.publisher.age();
        let pose_age = self.feeds.as_ref().map(|f| f.bridge.stale_for());
        let alive = liveness(
            status_age,
            pose_age,
            self.publisher.status.as_ref().is_some_and(|s| s.paused),
        );
        self.said = self.said.report(alive.as_ref());
        let status_age_text = match status_age {
            Some(age) => format!("status {:.1} s old", age.as_secs_f64()),
            None => "no status".to_string(),
        };
        let feeds_line = match (&self.feeds, follow) {
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
        let mut meshes: [Vec<crate::panel::Mesh>; 2] = [Vec::new(), Vec::new()];
        for (which, panel) in self.panels.iter_mut().enumerate() {
            let frame = panel.run(
                self.publisher.status.as_ref(),
                pointers[which],
                dt,
                &feeds_line,
                alive.as_ref(),
                self.publisher.error.as_deref(),
                &self.headset,
            );
            // The viewer's own settings, kept here and never sent: the publisher has no say in
            // how the headset turns.
            if let Some(crate::panel::LocalAction::SnapTurn(on)) = frame.local {
                self.headset.snap_turn = on;
                self.snap_armed = true;
                println!("view: snap turn {}", if on { "on" } else { "off" });
            }
            if !frame.textures.is_empty() {
                renderer.update_panel_textures(&frame.textures)?;
            }
            if let Some(writer) = self.commands.as_mut() {
                for command in &frame.commands {
                    println!("panel: {command:?}");
                    // A press that cannot be written is lost, and said so; it is no reason to
                    // take the headset's view away.
                    if let Err(e) = writer.send(&command.to_json()) {
                        println!("panel: could not send {command:?}: {e:#}");
                    }
                }
            }
            meshes[which] = frame.meshes;
        }
        // Farther first: the panels are blended over what is behind them and do not write depth,
        // so the nearer must be drawn last to be seen on top where they overlap -- as a panel
        // carried in front of the other is pointed at, now, by being the nearer.
        let order = back_to_front(&self.placements, self.view_point.to_world(head))
            .map(|which| (which, crate::math::multiply(&shift, &self.placements[which].model())));
        Ok(HandsAndPanels {
            grabs,
            drawn,
            meshes,
            order,
            show_muscles,
            show_tissue,
        })
    }

    /// Write each hand's grab intent to the grab channel, for the hands that have one.
    fn publish_grabs(&mut self, grabs: &[Option<crate::bridge::GrabIntent>; crate::bridge::HANDS]) {
        if let Some(f) = self.feeds.as_mut() {
            for (hand, intent) in grabs.iter().enumerate() {
                if let Some(intent) = intent {
                    f.grabs.publish(hand, intent);
                }
            }
        }
    }

    /// Draw the frame into the next swapchain image, hand it to the compositor as one projection
    /// layer for both eyes, and every two seconds say the rate and the worst CPU frame.
    #[allow(clippy::too_many_arguments)]
    fn submit(
        &mut self,
        swapchain: &mut openxr::Swapchain<openxr::Vulkan>,
        frame_stream: &mut openxr::FrameStream<openxr::Vulkan>,
        renderer: &crate::render::Renderer,
        stage: &openxr::Space,
        views: &[openxr::View],
        time: openxr::Time,
        extent: vk::Extent2D,
        frame: &HandsAndPanels,
        cpu_started: std::time::Instant,
    ) -> Result<()> {
        let panel_draws = frame.panel_draws();

        let image = swapchain.acquire_image()?;
        swapchain.wait_image(openxr::Duration::INFINITE)?;
        renderer.draw(
            image as usize,
            &crate::math::view_projections(views, 0.05, 50.0),
            Some(frame.drawn.as_slice()),
            if self.muscle_vertices.is_empty() || !frame.show_muscles { None } else { Some(self.muscle_vertices.as_slice()) },
            if self.tissue_vertices.is_empty() || !frame.show_tissue { None } else { Some(self.tissue_vertices.as_slice()) },
            &panel_draws,
        )?;
        swapchain.release_image()?;
        let cpu_ms = cpu_started.elapsed().as_secs_f64() * 1000.0;
        self.worst_cpu = self.worst_cpu.max(cpu_ms);
        self.window_worst = self.window_worst.max(cpu_ms);

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
                            .swapchain(swapchain)
                            .image_array_index(eye as u32)
                            .image_rect(rect),
                    )
            })
            .collect();
        frame_stream.end(
            time,
            openxr::EnvironmentBlendMode::OPAQUE,
            &[&openxr::CompositionLayerProjection::new()
                .space(stage)
                .views(&eyes)],
        )?;
        self.frames += 1;
        self.window_frames += 1;
        let window = self.window_started.elapsed().as_secs_f64();
        if window >= 2.0 {
            let pose_age = self
                .feeds
                .as_ref()
                .map(|f| format!(", pose {:.0} ms old", f.bridge.stale_for().as_secs_f64() * 1000.0))
                .unwrap_or_default();
            let held = self
                .holding
                .iter()
                .flatten()
                .map(|h| self.feeds.as_ref().map(|f| f.bridge.names[h.pose_bone].clone()).unwrap_or_default())
                .collect::<Vec<_>>()
                .join(" and ");
            let held = if held.is_empty() { held } else { format!(", holding {held}") };
            let bellies = self
                .feeds
                .as_ref()
                .and_then(|f| f.muscles.as_ref())
                .map(|m| format!(", {} muscle frames", m.published()))
                .unwrap_or_default();
            println!(
                "  {:.1} Hz, worst CPU frame {:.2} ms{pose_age}{bellies}{held}",
                self.window_frames as f64 / window,
                self.window_worst
            );
            self.window_started = std::time::Instant::now();
            self.window_frames = 0;
            self.window_worst = 0.0;
        }
        Ok(())
    }
}

/// The panels in the order to draw them: the farthest from the eye first. A fixed-size sort, so
/// nothing is allocated for it.
fn back_to_front<const N: usize>(placements: &[Placement; N], eye: [f32; 3]) -> [usize; N] {
    let distance = |which: &usize| {
        let c = placements[*which].centre();
        (c[0] - eye[0]).powi(2) + (c[1] - eye[1]).powi(2) + (c[2] - eye[2]).powi(2)
    };
    let mut order: [usize; N] = std::array::from_fn(|which| which);
    order.sort_by(|a, b| distance(b).total_cmp(&distance(a)));
    order
}

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
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
        if pump_events(&xr, &session, &mut event_storage, &mut running, &mut false)? == Flow::Exit {
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

    use crate::panel::Kind;

    /// The properties panel a metre ahead of the origin, facing it, at eye height.
    fn ahead(distance: f32) -> Placement {
        Placement::facing(Kind::Properties.size(), [0.0, 1.5, -distance], [0.0, 1.5, 0.0])
    }

    #[test]
    fn panels_are_drawn_farthest_first() {
        let near = ahead(0.6);
        let far = ahead(1.2);
        let eye = [0.0, 1.6, 0.0];
        assert_eq!(back_to_front(&[near, far], eye), [1, 0]);
        assert_eq!(back_to_front(&[far, near], eye), [0, 1]);
        // From behind the far one, the near one is the farther.
        assert_eq!(back_to_front(&[near, far], [0.0, 1.6, -3.0]), [0, 1]);
    }
}
