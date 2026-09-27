bs-humany studio {{VERSION}} -- a portable Linux build

Run it:

    ./bs-humany-studio

The studio itself is one dynamically-linked binary with the web application
embedded in it: the MuJoCo wasm, the skeleton meshes and the landmark tables are
inside it, so it needs no network and writes nothing until you ask it to.

What it does need from the machine is the system web view, because that is what
it renders through:

    libwebkit2gtk-4.1      libsoup-3.0      libgtk-3

Those are present on a current Fedora, Nobara, Ubuntu 24.04 or Arch and absent on
anything older. `ldd bs-humany-studio` says exactly what it wants. If it will
not start, take the AppImage from the same release instead -- that one carries
its own web view and runs where this will not.

WHAT ELSE IS IN HERE, AND WHY IT STAYS BESIDE THE STUDIO

    bs-humany-xr-viewer          the native OpenXR viewer
    assets-anatomical/data/      the mesh pack the viewer draws

The studio runs without either of them. They are what Connect VR viewer uses:
with SteamVR or another OpenXR runtime running, start a run and click it, and
the studio launches the viewer on the body it is simulating. The studio looks
for the viewer beside its own executable and hands it the mesh pack from
assets-anatomical/data beside it too, so keep the three together -- move the
directory as a whole, or unpack it again, rather than moving the binary out on
its own.

Two environment variables override where they are looked for, if you would
rather keep them somewhere else:

    BS_HUMANY_XR_VIEWER=/path/to/bs-humany-xr-viewer
    BS_HUMANY_PACK_DIR=/path/to/assets-anatomical/data

LICENSING

The program is Apache-2.0; see LICENSE and NOTICE.

The body's data is not. The mesh pack in assets-anatomical/, and what is built
into the studio from the same bones -- the meshes and the skeleton, the muscle
definitions of muscle-data, which are measured on those bones, and the trained
policies that stand and balance the body, whose weights were found against it --
are a derivative of

    BodyParts3D - The Database Center for Life Science - CC-BY-SA 2.1 Japan
    Z-Anatomy - The libre 3D atlas of anatomy - CC-BY-SA 4.0

and are distributed under CC BY-SA 4.0; assets-anatomical/LICENSE is that
licence and assets-anatomical/NOTICE says what the data is and where it came
from. NOTICE says which other parts of bs-humany are CC BY-SA 4.0 and why.
Redistributing this directory means passing that attribution on, and any
derivative of the data stays under CC BY-SA 4.0. The studio shows the same line
in its own footer, and every export written from it carries it in the file.

    https://github.com/WACOMalt/bs-humany
