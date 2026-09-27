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

use anyhow::{Context, Result, bail};
use ash::vk::{self, Handle};
use std::ffi::{CStr, CString};

use crate::grab::{Hold, let_go_of_everything, nearest_surface};
use crate::locomotion::{
    DEAD_ZONE, LIFT_SPEED, TURN_SPEED, Viewpoint, WALK_SPEED, home_placements, past_dead_zone, recentre,
    snap_turn, stick_on_panel,
};
use crate::panel::{Hit, Placement};

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

    // Where the body stands: the simulation's ground lifted to the stage floor. Known once the
    // status says the ground's height; zero, which is nearly every scenario, until then.
    let mut ground = 0.0f32;
    let mut place = crate::math::placement(ground);
    // Bones, the two controllers, the world slot at the placement, a pointer mark a hand, the
    // grid at the identity, the scenery at the placement, and an aim ray a hand; `Slots` says
    // where each is.
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
    // Where each hand's press began, from the trigger going down until it is let go. It decides
    // everything the press does: begun on a panel's face, that panel keeps the hand as its
    // pointer wherever the ray goes, so a slider dragged off the end still lands and the drag
    // never slides onto a strip and picks the panel up; begun on a strip, it carries the panel;
    // begun anywhere else, it presses nothing at all. The last is what the trigger was once
    // "armed" for: squeezing to grab a bone tends to pull the trigger too, and the ray sweeping
    // the panel then was clicking whatever it crossed.
    let mut press_on: [Option<PressOn>; crate::bridge::HANDS] = [None, None];
    // Which panel's face each hand's ray was on last frame. That hand's stick scrolls the panel
    // instead of moving the viewer; last frame's, because the sticks are read before the rays.
    let mut on_face: [Option<usize>; crate::bridge::HANDS] = [None, None];
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
    let controller_scale = crate::math::scale_matrix(1.0);
    let mut muscle_vertices: Vec<f32> = Vec::new();
    let mut tissue_vertices: Vec<f32> = Vec::new();
    // The connective tissue's fixed shape, rebuilt when the publisher's generation changes.
    let mut tissue_shape: Option<crate::tissue::TissueShape> = None;
    let mut tissue_generation: Option<u64> = None;
    let mut last_tick: Option<u64> = None;
    let mut last_muscle_tick: Option<u64> = None;

    // The panels: the properties panel to the viewer's right of the body, a little below eye
    // height, and the transport strip under it, both turned to face where the viewer stands --
    // `home_placements`, which a recentre puts them back to. Whichever hand is pointing at a
    // panel is its pointer; a hand that pressed on it keeps being the pointer until it lets go, so
    // a drag does not change hands mid-way. A hand on a grab strip carries the panel instead.
    // Where they overlap, the nearer is the one pointed at.
    use crate::panel::{Held, Kind, Panel};
    let mut placements = home_placements([0.0, 0.0, 0.0], [0.0, 0.0, -1.0]);
    let mut panels = [Panel::new(Kind::Properties), Panel::new(Kind::Transport)];
    let mut pointer_hand: [Option<usize>; 2] = [None, None];
    let mut carrying: [Option<(usize, Held)>; crate::bridge::HANDS] = [None, None];
    // What the viewer knows of itself for the panels to show: which controllers are in hand, and
    // whether the right stick turns in steps. Smooth turning is the default; snap turn is a box on
    // the transport strip for whoever the smooth turn makes queasy.
    let mut headset = crate::panel::Headset::default();
    let mut profiles_changed = false;
    // Whether a snap turn is armed: the stick has come back to the middle since the last step.
    let mut snap_armed = true;

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
    // Whether the last frame was drawn, which is whether the hands were last written. The slots
    // are only rewritten on a frame that is drawn, so every way out of drawing -- the session
    // stopping, the runtime saying not to render, the session or the loop ending -- first
    // writes both hands open: the simulation would otherwise read the last squeeze for as long
    // as the file stands. Its readers keep a watch on the write count as well, which is what
    // covers a viewer that is killed and never gets to say so.
    let mut drawing = false;

    while started.elapsed().as_secs_f32() < seconds {
        let flow = pump_events(&xr, &session, &mut event_storage, &mut running, &mut profiles_changed)?;
        // The controllers in hand changed, or the runtime has settled on them for the first time:
        // which they are is said once, on the terminal and on the panels, where somebody holding
        // a controller the guide was not written for can see what the runtime made of it.
        if profiles_changed && flow == Flow::Continue {
            profiles_changed = false;
            headset.profiles = hands.profiles(&xr, &session);
            for (side, profile) in ["left", "right"].iter().zip(&headset.profiles) {
                println!("hands: {side} uses {profile}");
            }
        }
        if flow == Flow::Exit {
            let_go_of_everything(
                feeds.as_mut().map(|f| &mut f.grabs),
                &mut holding,
                "the session is over",
            );
            // Nothing is destroyed while the GPU may still be drawing into it.
            renderer.wait_idle();
            return Ok(());
        }
        if !running {
            if drawing {
                drawing = false;
                let_go_of_everything(
                    feeds.as_mut().map(|f| &mut f.grabs),
                    &mut holding,
                    "the session stopped",
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
            continue;
        }

        let state = frame_wait.wait()?;
        frame_stream.begin()?;
        if !state.should_render {
            if drawing {
                drawing = false;
                let_go_of_everything(
                    feeds.as_mut().map(|f| &mut f.grabs),
                    &mut holding,
                    "nothing is being drawn",
                );
            }
            frame_stream.end(
                state.predicted_display_time,
                openxr::EnvironmentBlendMode::OPAQUE,
                &[],
            )?;
            continue;
        }
        drawing = true;

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
                    place = crate::math::placement(ground);
                    matrices[slots.world] = place;
                    matrices[slots.scene] = place;
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
                    let scale = crate::math::scale_matrix(b.dataset_scale as f32);
                    for (i, found) in f.pose_index.iter().enumerate() {
                        matrices[i] = match found {
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
                                    &place,
                                    &crate::math::multiply(
                                        &current,
                                        &crate::math::multiply(&rest_inverse, &scale),
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
                        crate::geometry::tube_vertices(
                            &frame.rings,
                            m.rings,
                            m.segments,
                            slots.world as u32,
                            tension,
                            &mut muscle_vertices,
                        );
                    }
                }
            }
        }

        hands.sync(&session)?;

        // The sticks, each either moving the viewer or, while its hand's ray is on a panel's
        // face, scrolling that panel: the one stick cannot do both, and a person aiming at a
        // long tab and pushing the stick wants the tab to move, not the room.
        let now = std::time::Instant::now();
        let dt = (now - last_frame).as_secs_f32().min(0.1);
        last_frame = now;
        let head = views[0].pose.position;
        let head = [head.x, head.y, head.z];
        // The stick pressed in, on either hand: back to the start, the panels in front. Before
        // anything this frame is aimed or carried, so all of it is in the recentred world.
        let mut recentred = false;
        for hand in 0..crate::bridge::HANDS {
            if hands.recentre_pressed(&session, hand)? {
                recentred = true;
                hands.pulse(&session, hand, FIRM_TICK);
            }
        }
        if recentred {
            for (which, _) in carrying.iter().flatten() {
                panels[*which].grabbed = false;
            }
            let q = views[0].pose.orientation;
            recentre(&mut view_point, &mut placements, &mut carrying, head, [q.x, q.y, q.z, q.w]);
            // A press under way was aimed through the world as it was; it presses nothing more,
            // and the trigger must be let go and pulled again to press on the panel that has
            // come to meet it.
            for press in press_on.iter_mut().filter(|p| p.is_some()) {
                *press = Some(PressOn::Air);
            }
            // So is a hold: its target is the hand carried into the world through the viewpoint,
            // and the world has just jumped, which would fling the body after it. A squeeze that
            // is still held takes hold afresh, where the bone now is.
            let_go_of_everything(feeds.as_mut().map(|f| &mut f.grabs), &mut holding, "recentred");
            println!("view: recentred");
        }
        let mut scroll = [0.0f32; 2];
        let mut sticks = [[0.0f32; 2]; crate::bridge::HANDS];
        for (hand, stick) in sticks.iter_mut().enumerate() {
            let (moving, scrolling) = stick_on_panel(hands.thumbstick(&session, hand)?, on_face[hand].is_some(), DEAD_ZONE);
            *stick = moving;
            if let Some(which) = on_face[hand] {
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
            let step = view_point.to_world_direction([
                (right[0] * stick[0] + forward[0] * stick[1]) * scale,
                (right[1] * stick[0] + forward[1] * stick[1]) * scale,
                (right[2] * stick[0] + forward[2] * stick[1]) * scale,
            ]);
            for (offset, moved) in view_point.offset.iter_mut().zip(step) {
                *offset += moved;
            }
        }
        // Turning and rising: the right stick. Left and right turn the viewer about where the
        // head is, so it is a turn on the spot rather than a swing around the middle of the
        // stage -- smoothly, or in steps with snap turn on; forward and back lift and lower.
        // Each axis has its own dead zone, so a stick pushed to turn does not also drift upwards.
        let look = sticks[1];
        if headset.snap_turn {
            let by = snap_turn(look[0], &mut snap_armed);
            if by != 0.0 {
                view_point.turn(by, head);
            }
        } else {
            let turn = past_dead_zone(look[0], DEAD_ZONE);
            if turn != 0.0 {
                view_point.turn(turn * TURN_SPEED * dt, head);
            }
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
        // The tubes are the muscles' volumes, swept from the belly rings, so they follow that box
        // alone. Muscle paths are the desktop's origin-to-insertion lines, which nothing here
        // draws; following either box drew tubes for a desktop showing paths with volumes off.
        let show_muscles = overlay("muscleVolumes");
        let show_tissue = overlay("tissue");
        matrices[slots.stage] =
            crate::math::scale_matrix(if overlay("grid") { 1.0 } else { 0.0 });
        // What is drawn: the world's slots through the shift, the hands' slots as they are.
        let mut drawn = matrices.clone();
        for (slot, m) in drawn.iter_mut().enumerate() {
            if !slots.is_hand(slot) {
                *m = crate::math::multiply(&shift, &matrices[slot]);
            }
        }
        // The hands: located in the stage like the eyes, drawn as cubes at their grips, and asked
        // whether they are squeezing. A hand the runtime cannot place this frame keeps its last
        // cube and cannot begin a grab, but a grab already begun continues at the last target.
        let mut pointers = [crate::panel::Pointer::default(); 2];
        let mut pointer_candidate: [Option<(usize, egui::Pos2, bool)>; 2] = [None, None];
        for hand in 0..crate::bridge::HANDS {
            let slot = slots.controller(hand);
            let located = hands.locate(&hands.grip_spaces[hand], &stage, state.predicted_display_time)?;
            if let Some((position, orientation)) = located {
                if !hand_seen[hand] {
                    hand_seen[hand] = true;
                    println!("hand {}: tracked", ["left", "right"][hand]);
                }
                drawn[slot] = crate::math::multiply(
                    &crate::math::pose_matrix(position, orientation),
                    &controller_scale,
                );
            }
            // Where the aim ray meets the panel, if it does: a mark there, and a candidate for
            // being the pointer.
            let marker = slots.marker(hand);
            drawn[marker] = crate::math::scale_matrix(0.0);
            let pull = hands.trigger(&session, hand)?;
            let was_down = trigger_down[hand];
            trigger_down[hand] = if was_down { pull > 0.25 } else { pull > 0.6 };
            let pressed = trigger_down[hand];
            let aimed = hands.locate(&hands.aim_spaces[hand], &stage, state.predicted_display_time)?;
            // The panels are of the world; the ray is of the stage. Carry the ray over, turn
            // and all: a viewer who has turned no longer points where the stage says.
            let ray = aimed.map(|(position, orientation)| {
                let q = view_point.to_world_rotation(orientation);
                (
                    view_point.to_world(position),
                    q,
                    crate::math::rotate([0.0, 0.0, -1.0], q),
                )
            });
            // How far the drawn ray reaches: to the mark where it meets a panel, or to the strip
            // of the panel it is carrying; to RAY_REACH when it meets nothing.
            let mut reach: Option<f32> = None;
            // A hand carrying a panel keeps carrying it while the trigger is down, wherever it
            // points; let go, the panel stays.
            on_face[hand] = None;
            if let Some((which, held)) = carrying[hand] {
                match ray {
                    Some((from, q, forward)) if pressed => {
                        placements[which] = placements[which].carried(&held, from, q);
                        reach = placements[which].hit(from, forward).map(|(t, _)| t);
                    }
                    Some(_) => {
                        carrying[hand] = None;
                        press_on[hand] = None;
                        panels[which].grabbed = false;
                        hands.pulse(&session, hand, FIRM_TICK);
                        println!("hand {}: put the panel down", ["left", "right"][hand]);
                    }
                    None => {}
                }
            } else {
                // A hand that is holding a bone is busy; its ray is not a pointer.
                let busy = holding[hand].is_some();
                let pointing = ray.map(|(from, _, forward)| (from, forward));
                // A mark where the ray meets a panel, in the stage, and the ray drawn as far as
                // it. The distance is the same in the stage as in the world, which differ only by
                // a turn and a shift. Measured to the mark rather than along the ray: the two are
                // the same while the ray is on the face, and for a press held past a panel's
                // edge, whose mark waits at the edge, the ray still stops about the panel's
                // depth instead of running on through it.
                let mut mark = |which: usize, at: egui::Pos2| {
                    let in_stage = view_point.to_stage(placements[which].to_world(at));
                    if let Some((from, _)) = aimed {
                        reach = Some(distance(from, in_stage));
                    }
                    crate::math::pose_matrix(in_stage, [0.0, 0.0, 0.0, 1.0])
                };
                match aim(&placements, pointing, pressed, busy, &mut press_on[hand]) {
                    Aim::Face { which, at, pressing } => {
                        drawn[marker] = mark(which, at);
                        on_face[hand] = Some(which);
                        // A tick as a press lands on a face: the trigger's travel says nothing
                        // about whether the button under the mark took it.
                        if pressing && !was_down {
                            hands.pulse(&session, hand, PRESS_TICK);
                        }
                        // The hand that pressed keeps the panel; otherwise the first hand on it,
                        // unless a later one is pressing and the first only pointing.
                        let keep = pointer_hand[which] == Some(hand);
                        let outranks = pointer_candidate[which].map_or(true, |(_, _, other)| pressing && !other);
                        if keep || outranks {
                            pointer_candidate[which] = Some((hand, at, pressing));
                        }
                    }
                    Aim::Strip { which, at, take } => {
                        drawn[marker] = mark(which, at);
                        let already_carried = carrying.iter().flatten().any(|(w, _)| *w == which);
                        if take && !already_carried {
                            if let Some((from, q, _)) = ray {
                                carrying[hand] = Some((which, placements[which].held_by(from, q)));
                                panels[which].grabbed = true;
                                hands.pulse(&session, hand, FIRM_TICK);
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
            drawn[slots.ray(hand)] = match aimed {
                Some((position, orientation)) if holding[hand].is_none() => crate::geometry::ray_matrix(
                    position,
                    orientation,
                    reach.unwrap_or(crate::geometry::RAY_REACH),
                ),
                _ => crate::math::scale_matrix(0.0),
            };
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
                            hands.pulse(&session, hand, FIRM_TICK);
                            // A hand holding a bone draws no ray, from this frame on.
                            drawn[slots.ray(hand)] = crate::math::scale_matrix(0.0);
                            // The surface is in the stage; the simulation wants the world.
                            let point = crate::math::unplace(view_point.to_world(surface), ground);
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
                                rotation: crate::math::unplace_rotation(
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
                            let delta = crate::math::quaternion_multiply(
                                hand_q,
                                crate::math::quaternion_conjugate(hold.hand_q),
                            );
                            let carried = crate::math::rotate(hold.offset, delta);
                            (
                                crate::math::unplace(
                                    view_point.to_world([
                                        hand_at[0] + carried[0],
                                        hand_at[1] + carried[1],
                                        hand_at[2] + carried[2],
                                    ]),
                                    ground,
                                ),
                                crate::math::unplace_rotation(
                                    view_point.to_world_rotation(hand_q),
                                ),
                            )
                        }
                        None => (
                            hold.point,
                            crate::math::unplace_rotation(
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
                    hands.pulse(&session, hand, FIRM_TICK);
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
                        scroll: scroll[which],
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
                dt,
                &feeds_line,
                alive.as_ref(),
                publisher.error.as_deref(),
                &headset,
            );
            // The viewer's own settings, kept here and never sent: the publisher has no say in
            // how the headset turns.
            if let Some(crate::panel::LocalAction::SnapTurn(on)) = frame.local {
                headset.snap_turn = on;
                snap_armed = true;
                println!("view: snap turn {}", if on { "on" } else { "off" });
            }
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
        // Farther first: the panels are blended over what is behind them and do not write depth,
        // so the nearer must be drawn last to be seen on top where they overlap -- as a panel
        // carried in front of the other is pointed at, now, by being the nearer.
        let panel_draws: Vec<crate::render::PanelDraw> = back_to_front(&placements, view_point.to_world(head))
            .into_iter()
            .map(|which| crate::render::PanelDraw {
                model: crate::math::multiply(&shift, &placements[which].model()),
                meshes: &panel_meshes[which],
            })
            .collect();

        let image = swapchain.acquire_image()?;
        swapchain.wait_image(openxr::Duration::INFINITE)?;
        renderer.draw(
            image as usize,
            &crate::math::view_projections(&views, 0.05, 50.0),
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

    let_go_of_everything(
        feeds.as_mut().map(|f| &mut f.grabs),
        &mut holding,
        "the viewer is done",
    );
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
/// writes ten times a second while it lives.
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

/// Where a press began, which decides what it does until the trigger is let go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PressOn {
    /// On panel `which`'s face: that panel keeps the hand as its pointer until release.
    Face(usize),
    /// On panel `which`'s grab strip: the only press that carries a panel.
    Strip(usize),
    /// Anywhere else -- empty air, a bone, a hand holding a bone. It presses nothing.
    Air,
}

/// What a hand's ray does to the panels this frame.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Aim {
    /// Nothing: the ray meets no panel, or the hand is busy.
    Nothing,
    /// On panel `which`'s face at `at`, in points; `pressing` while a press begun there is held.
    Face { which: usize, at: egui::Pos2, pressing: bool },
    /// On panel `which`'s grab strip; `take` when a press begun on this strip is held.
    Strip { which: usize, at: egui::Pos2, take: bool },
}

/// The panel a ray meets first, and where: of panels that overlap on the ray, the nearer, which
/// is the one in front whatever order the panels are kept in.
fn nearest_hit(placements: &[Placement], from: [f32; 3], direction: [f32; 3]) -> Option<(usize, Hit)> {
    placements
        .iter()
        .enumerate()
        .filter_map(|(which, p)| p.hit(from, direction).map(|(t, hit)| (which, t, hit)))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(which, _, hit)| (which, hit))
}

/// What a hand's ray does to the panels, given where its press began, which this keeps: set when
/// the trigger goes down, from what the ray was on then, and cleared when it is let go.
///
/// A press begun on a face keeps that panel whatever the ray meets next, at the ray's point held
/// to the face's edges, so a drag past the edge still ends where it was aimed and never slides
/// onto a strip. If the panel is lost to the ray altogether -- no ray, or the panel behind it --
/// the press is over, and becomes one begun in the air, so that the ray coming back with the
/// trigger still held does not press again on whatever it comes back to. A busy hand, one
/// holding a bone, aims at nothing and its press, begun or held, presses nothing.
fn aim(
    placements: &[Placement],
    ray: Option<([f32; 3], [f32; 3])>,
    pressed: bool,
    busy: bool,
    press: &mut Option<PressOn>,
) -> Aim {
    let hit = if busy { None } else { ray.and_then(|(from, direction)| nearest_hit(placements, from, direction)) };
    if !pressed {
        *press = None;
    } else if press.is_none() || busy {
        *press = Some(match hit {
            _ if busy => PressOn::Air,
            Some((which, Hit::Face(_))) => PressOn::Face(which),
            Some((which, Hit::Grab(_))) => PressOn::Strip(which),
            None => PressOn::Air,
        });
    }
    if busy {
        return Aim::Nothing;
    }
    if let Some(PressOn::Face(which)) = *press {
        return match ray.and_then(|(from, direction)| placements[which].project(from, direction)) {
            Some(at) => Aim::Face { which, at, pressing: true },
            None => {
                *press = Some(PressOn::Air);
                Aim::Nothing
            }
        };
    }
    match hit {
        Some((which, Hit::Face(at))) => Aim::Face { which, at, pressing: false },
        Some((which, Hit::Grab(at))) => Aim::Strip { which, at, take: *press == Some(PressOn::Strip(which)) },
        None => Aim::Nothing,
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

/// A haptic tick: how hard, 0..1, and for how long, in seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Tick {
    amplitude: f32,
    seconds: f32,
}

/// The tick a press gives as it lands on a panel's face: short and light, because every press
/// gives one, and a row of buttons pressed in turn would be a buzz if each were heavy.
const PRESS_TICK: Tick = Tick {
    amplitude: 0.3,
    seconds: 0.015,
};

/// The tick for taking hold and letting go -- a bone grabbed or released, a panel taken or put
/// down: longer and firmer, because the hand has changed what it is doing, and the eye is often
/// on the body rather than on the hand when it happens.
const FIRM_TICK: Tick = Tick {
    amplitude: 0.6,
    seconds: 0.040,
};

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// One interaction profile's bindings: which of its inputs each of the viewer's actions reads.
///
/// Every profile has a grip and an aim pose and a vibration, spelled alike, so those are not
/// listed. The rest differs by controller, and a path a profile has not got makes the runtime
/// refuse that profile's whole suggestion, so each is spelled exactly as the OpenXR
/// specification's list of interaction profiles spells it for that controller.
struct Binding {
    profile: &'static str,
    /// The grab: an analogue grip where the controller has one, which the runtime reads as a
    /// boolean at a threshold of its own; a click otherwise.
    squeeze: &'static str,
    /// The panels' press, analogue for the reason `Hands::trigger` gives.
    trigger: &'static str,
    /// What walks, turns and lifts: a thumbstick, or the Vive's trackpad. None on a controller
    /// with neither.
    stick: Option<&'static str>,
    /// What recentres: that same stick or pad, pressed in.
    recentre: Option<&'static str>,
    /// Whether the viewer cannot run without this profile. Only the Index's: it is the
    /// controller this was built against, and a runtime refusing it means the bindings are
    /// wrong, which should stop the viewer rather than leave it running with dead hands. Every
    /// other profile is a courtesy, and a refusal is said and passed over.
    required: bool,
}

/// The controllers the viewer is bound for. The runtime picks the one for the controller in
/// hand; one it knows no better binding for falls back to the simple profile, which every runtime
/// knows: a select that is both the grab and the press, and no stick.
const BINDINGS: &[Binding] = &[
    Binding {
        profile: "/interaction_profiles/valve/index_controller",
        squeeze: "squeeze/value",
        trigger: "trigger/value",
        stick: Some("thumbstick"),
        recentre: Some("thumbstick/click"),
        required: true,
    },
    Binding {
        profile: "/interaction_profiles/oculus/touch_controller",
        squeeze: "squeeze/value",
        trigger: "trigger/value",
        stick: Some("thumbstick"),
        recentre: Some("thumbstick/click"),
        required: false,
    },
    Binding {
        profile: "/interaction_profiles/microsoft/motion_controller",
        squeeze: "squeeze/click",
        trigger: "trigger/value",
        stick: Some("thumbstick"),
        recentre: Some("thumbstick/click"),
        required: false,
    },
    // Accepted only from an instance made with its extension, which `bring_up` asks for when the
    // runtime has it; without, the suggestion is refused like any other courtesy.
    Binding {
        profile: "/interaction_profiles/hp/mixed_reality_controller",
        squeeze: "squeeze/value",
        trigger: "trigger/value",
        stick: Some("thumbstick"),
        recentre: Some("thumbstick/click"),
        required: false,
    },
    // The Vive's trackpad is its stick: where the thumb rests on it is the deflection, and
    // pressing it in is the recentre.
    Binding {
        profile: "/interaction_profiles/htc/vive_controller",
        squeeze: "squeeze/click",
        trigger: "trigger/value",
        stick: Some("trackpad"),
        recentre: Some("trackpad/click"),
        required: false,
    },
    Binding {
        profile: "/interaction_profiles/khr/simple_controller",
        squeeze: "select/click",
        trigger: "select/click",
        stick: None,
        recentre: None,
        required: false,
    },
];

/// An interaction profile's path as the log and the panel say it: without the
/// `/interaction_profiles/` every one of them begins with, and "none" for the null path, which is
/// what the runtime says of a hand with no controller in it, or one it has not bound yet.
fn profile_name(path: &str) -> &str {
    if path.is_empty() {
        "none"
    } else {
        path.strip_prefix("/interaction_profiles/").unwrap_or(path)
    }
}

/// The tracked controllers as OpenXR actions: a grip pose, an aim pose, a squeeze and a trigger,
/// a stick and its click, per hand, and the vibration back. The grip is where the cube is drawn
/// and the squeeze grabs; the aim is the ray that points at the panel and the trigger presses what
/// it points at.
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
    /// The stick pressed in: back to where the viewer started, with the panels in front.
    recentre: openxr::Action<bool>,
    /// The controller's vibration, which is how a press, a grab or a panel taken is felt.
    haptic: openxr::Action<openxr::Haptic>,
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
        let recentre = set.create_action::<bool>("recentre", "Recentre", &paths)?;
        let haptic = set.create_action::<openxr::Haptic>("tick", "Tick", &paths)?;
        // Suggested per profile, from `BINDINGS`; the runtime picks the profile for the
        // controller in hand.
        let suggest = |binding: &Binding| -> Result<()> {
            let mut bindings = Vec::new();
            for side in ["left", "right"] {
                let input = |name: &str| xr.string_to_path(&format!("/user/hand/{side}/input/{name}"));
                if let Some(stick) = binding.stick {
                    bindings.push(openxr::Binding::new(&thumbstick, input(stick)?));
                }
                if let Some(click) = binding.recentre {
                    bindings.push(openxr::Binding::new(&recentre, input(click)?));
                }
                bindings.push(openxr::Binding::new(&grip, input("grip/pose")?));
                bindings.push(openxr::Binding::new(&aim, input("aim/pose")?));
                bindings.push(openxr::Binding::new(&squeeze, input(binding.squeeze)?));
                bindings.push(openxr::Binding::new(&trigger, input(binding.trigger)?));
                // Every profile here names the vibration `output/haptic`, so this is the one
                // path, spelled as they all spell it.
                bindings.push(openxr::Binding::new(
                    &haptic,
                    xr.string_to_path(&format!("/user/hand/{side}/output/haptic"))?,
                ));
            }
            xr.suggest_interaction_profile_bindings(xr.string_to_path(binding.profile)?, &bindings)?;
            Ok(())
        };
        for binding in BINDINGS {
            match suggest(binding) {
                Ok(()) => {}
                Err(e) if binding.required => {
                    return Err(e.context(format!("binding the {} controller", profile_name(binding.profile))));
                }
                Err(e) => println!(
                    "hands: the {} profile was refused ({e}); carrying on without it",
                    profile_name(binding.profile)
                ),
            }
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
            recentre,
            haptic,
            paths,
            grip_spaces,
            aim_spaces,
        })
    }

    /// Which interaction profile the runtime is using for each hand, as `profile_name` says it.
    ///
    /// Asked when the runtime says the profiles changed, never every frame. A runtime that will
    /// not say is said on the terminal and read as no profile: this only ever feeds the log and a
    /// note on the panel, and neither is a reason to stop.
    fn profiles(
        &self,
        xr: &openxr::Instance,
        session: &openxr::Session<openxr::Vulkan>,
    ) -> [String; crate::bridge::HANDS] {
        std::array::from_fn(|hand| {
            let path = session.current_interaction_profile(self.paths[hand]).and_then(|path| {
                if path == openxr::Path::NULL {
                    Ok(String::new())
                } else {
                    xr.path_to_string(path)
                }
            });
            match path {
                Ok(path) => profile_name(&path).to_string(),
                Err(e) => {
                    println!("hands: the runtime would not say what the {} hand is ({e})", ["left", "right"][hand]);
                    profile_name("").to_string()
                }
            }
        })
    }

    /// Whether a hand's stick was pressed in since the last sync: the press, once, rather than
    /// every frame it is held, so a stick held in recentres once.
    fn recentre_pressed(&self, session: &openxr::Session<openxr::Vulkan>, hand: usize) -> Result<bool> {
        let state = self.recentre.state(session, self.paths[hand])?;
        Ok(state.is_active && state.current_state && state.changed_since_last_sync)
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

    /// Vibrate one hand's controller: a tick, at the runtime's own frequency for the device.
    ///
    /// A courtesy, never a reason to stop: a runtime that refuses one says so and the frame goes
    /// on, since the press or the grab it marks has already happened. A controller with no
    /// vibration, or none bound, is a no-op in OpenXR rather than an error.
    fn pulse(&self, session: &openxr::Session<openxr::Vulkan>, hand: usize, tick: Tick) {
        let vibration = openxr::HapticVibration::new()
            .amplitude(tick.amplitude)
            .duration(openxr::Duration::from_nanos((tick.seconds * 1e9) as i64))
            .frequency(openxr::FREQUENCY_UNSPECIFIED);
        if let Err(e) = self.haptic.apply_feedback(session, self.paths[hand], &vibration) {
            println!("hand {}: the runtime refused a haptic tick ({e})", ["left", "right"][hand]);
        }
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
    fn every_controller_binds_the_same_actions_as_its_profile_spells_them() {
        // The Index's is the one that must not be refused; everything else is a courtesy.
        let required: Vec<&str> = BINDINGS.iter().filter(|b| b.required).map(|b| profile_name(b.profile)).collect();
        assert_eq!(required, ["valve/index_controller"]);
        for binding in BINDINGS {
            let name = profile_name(binding.profile);
            // A stick recentres by being pressed in, so a controller has both or neither.
            assert_eq!(binding.stick.is_some(), binding.recentre.is_some(), "{name}");
            if let (Some(stick), Some(click)) = (binding.stick, binding.recentre) {
                assert_eq!(click, format!("{stick}/click"), "{name}");
            }
        }
        for name in ["oculus/touch_controller", "microsoft/motion_controller", "htc/vive_controller", "khr/simple_controller"] {
            assert!(BINDINGS.iter().any(|b| profile_name(b.profile) == name), "no binding for {name}");
        }
        assert_eq!(profile_name(""), "none");
        assert_eq!(profile_name("/interaction_profiles/htc/vive_controller"), "htc/vive_controller");
    }

    use crate::panel::{GRAB_WIDTH, Kind};

    /// The properties panel a metre ahead of the origin, facing it, at eye height.
    fn ahead(distance: f32) -> Placement {
        Placement::facing(Kind::Properties.size(), [0.0, 1.5, -distance], [0.0, 1.5, 0.0])
    }

    /// A ray from the origin at eye height to this point of `panel`.
    fn at(panel: &Placement, p: egui::Pos2) -> Option<([f32; 3], [f32; 3])> {
        let from = [0.0, 1.5, 0.0];
        let w = panel.to_world(p);
        Some((from, [w[0] - from[0], w[1] - from[1], w[2] - from[2]]))
    }

    #[test]
    fn of_two_panels_on_one_ray_the_nearer_is_hit_whatever_their_order() {
        let near = ahead(0.6);
        let far = ahead(1.2);
        let (from, direction) = at(&near, egui::pos2(320.0, 390.0)).unwrap();
        assert!(far.hit(from, direction).is_some() && near.hit(from, direction).is_some());
        assert_eq!(nearest_hit(&[far, near], from, direction).map(|(which, _)| which), Some(1));
        assert_eq!(nearest_hit(&[near, far], from, direction).map(|(which, _)| which), Some(0));
        // And a press is taken by the nearer one.
        let mut press = None;
        let aimed = aim(&[far, near], Some((from, direction)), true, false, &mut press);
        assert!(matches!(aimed, Aim::Face { which: 1, pressing: true, .. }), "{aimed:?}");
        assert_eq!(press, Some(PressOn::Face(1)));
    }

    #[test]
    fn a_press_begun_on_the_face_keeps_the_panel_and_never_carries_it() {
        let panel = [ahead(1.0)];
        let mut press = None;
        let begun = aim(&panel, at(&panel[0], egui::pos2(200.0, 300.0)), true, false, &mut press);
        assert!(matches!(begun, Aim::Face { which: 0, pressing: true, .. }), "{begun:?}");
        // Slid onto the strip with the trigger held: still the face, at the strip's inner side,
        // and nothing taken.
        let onto_strip = aim(&panel, at(&panel[0], egui::pos2(10.0, 300.0)), true, false, &mut press);
        match onto_strip {
            Aim::Face { which: 0, at, pressing: true } => assert!((at.x - GRAB_WIDTH).abs() < 1e-2, "{at:?}"),
            other => panic!("{other:?}"),
        }
        // Past the panel's right edge: still the face, at the edge.
        let past = aim(&panel, at(&panel[0], egui::pos2(900.0, 300.0)), true, false, &mut press);
        match past {
            Aim::Face { which: 0, at, pressing: true } => assert!((at.x - 640.0).abs() < 1e-2, "{at:?}"),
            other => panic!("{other:?}"),
        }
        // Let go on the strip: the press is over, and nothing was carried.
        let released = aim(&panel, at(&panel[0], egui::pos2(10.0, 300.0)), false, false, &mut press);
        assert!(matches!(released, Aim::Strip { take: false, .. }), "{released:?}");
        assert_eq!(press, None);
    }

    #[test]
    fn only_a_press_begun_on_the_strip_carries_the_panel() {
        let panel = [ahead(1.0)];
        let mut press = None;
        let taken = aim(&panel, at(&panel[0], egui::pos2(10.0, 300.0)), true, false, &mut press);
        assert!(matches!(taken, Aim::Strip { which: 0, take: true, .. }), "{taken:?}");
        assert_eq!(press, Some(PressOn::Strip(0)));
    }

    #[test]
    fn a_press_begun_in_the_air_presses_nothing_it_sweeps_across() {
        let panel = [ahead(1.0)];
        let mut press = None;
        // Down while pointing away from the panel.
        assert_eq!(aim(&panel, Some(([0.0, 1.5, 0.0], [0.0, 0.0, 1.0])), true, false, &mut press), Aim::Nothing);
        assert_eq!(press, Some(PressOn::Air));
        // Swept across the face and onto the strip, still held: a pointer, never a press or a
        // carry.
        let face = aim(&panel, at(&panel[0], egui::pos2(300.0, 300.0)), true, false, &mut press);
        assert!(matches!(face, Aim::Face { pressing: false, .. }), "{face:?}");
        let strip = aim(&panel, at(&panel[0], egui::pos2(10.0, 300.0)), true, false, &mut press);
        assert!(matches!(strip, Aim::Strip { take: false, .. }), "{strip:?}");
        // A hand holding a bone aims at nothing, pressed or not.
        let mut busy = None;
        assert_eq!(aim(&panel, at(&panel[0], egui::pos2(300.0, 300.0)), true, true, &mut busy), Aim::Nothing);
        assert_eq!(busy, Some(PressOn::Air));
    }

    #[test]
    fn a_press_that_loses_its_panel_does_not_press_again_when_the_ray_comes_back() {
        let panel = [ahead(1.0)];
        let mut press = None;
        aim(&panel, at(&panel[0], egui::pos2(300.0, 300.0)), true, false, &mut press);
        // The ray is lost with the trigger held: the panel lets go.
        assert_eq!(aim(&panel, None, true, false, &mut press), Aim::Nothing);
        // Back on a button with the trigger still held: a pointer, not a second press.
        let back = aim(&panel, at(&panel[0], egui::pos2(300.0, 300.0)), true, false, &mut press);
        assert!(matches!(back, Aim::Face { pressing: false, .. }), "{back:?}");
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
