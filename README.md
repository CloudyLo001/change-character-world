# Splat Playground

A third-person character playground built with Three.js + Vite. The world is a
streamed Mint Gaussian-splat environment (with an invisible physics collider),
the character is a Mint-generated rigged humanoid, and both are hot-swappable
from a small in-app switcher.

## Run it

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5188.

## Controls

| Input | Action |
| --- | --- |
| `W A S D` / arrows | Move (camera-relative) |
| `Shift` | Run |
| `Space` | Jump |
| Drag on the canvas | Orbit the camera |
| Mouse wheel | Zoom |
| `[` / `]` | Lower/raise the character's ground height (per world, saved) |
| `,` / `.` | Dim/brighten the character's lighting (saved) |
| `;` / `'` | Loosen/tighten how close the arms sit to the body (saved) |
| `L` | Re-bake the world light probe at the current spot |
| `H` | Hide/show all UI (for clean recording) |

The bottom-center overlay has two dropdowns — **World** and **Character** —
listing everything registered in `mint-assets.json` plus anything you have
uploaded. Picking an entry swaps it live; the last selection is remembered
between reloads. The ⚙ button in the top right opens the asset library.

## Uploading your own assets

Open ⚙ and drop files in. Uploads are stored in this browser (IndexedDB), so
they appear immediately without a rebuild, but they stay on this machine and
are not part of the repo.

- **World** — a Mint world export: `.rad`, `.spz` or `.ply`. The format is
  detected from the file's own header. Mint's export has no collision mesh, so
  the ground is read from the splats themselves (see below); if you happen to
  have a collider `.glb`, select it alongside the splat file and it will be
  used instead for exact collision.
- **Character** — select the rigged `.glb` and its animation clip `.glb` files
  together. Clips are matched to walk / run / jump by filename using the same
  rules as the project registry, and the panel tells you which ones are
  missing. A character with no clips simply stands still.

**Importing from Mint by link.** Mint's API is not reachable from the browser,
so pasting a mint.gg link queues a request instead. Copy it, paste it to Claude
in chat, and Claude runs the MCP import — including rigging a character that
has no walk cycle — which lands the asset in `mint-assets.json` permanently
rather than in browser storage.

**Ground in uploaded worlds.** With no collider, heights are read by raycasting
the splats on a coarse grid around the character and caching them, a couple of
cells per frame. You can walk over uneven ground, but there is no wall
collision — nothing stops you walking through a building.

## How assets work

`mint-assets.json` is the single source of truth. The app reads it at build
time and derives the switcher catalog from it:

- **Worlds** are `mode: "remote_stream"` entries: a Mint CDN RAD splat URL plus
  a collider GLB URL. Nothing is downloaded into the repo; the splat streams at
  runtime. The collider is loaded invisibly and drives ground/wall collision.
- **Characters** are synced local files under `public/assets/mint/<key>/`: one
  `rigged_character` GLB plus `animation_clip` GLBs. Clip roles (idle / walk /
  run / jump) are matched from the recorded clip filenames.
- Each entry has an editable `transform`. Worlds with an identity transform get
  the standard World Labs calibration (rotation `[π, π, 0]`, scale `2.5`,
  y `1.5`) applied to the shared splat+collider root automatically.

## How the character is lit and grounded

Both of these are derived from the world at runtime, so a world you add later
gets them for free — there is nothing to hand-author per world.

- **Lighting.** Spark renders the loaded splat world into a cube map around the
  character. That becomes `scene.environment` (image-based lighting) and also
  drives a hemisphere and key light whose colors and direction are read back
  out of the six cube faces. Standing under neon signage gives a dim violet key;
  standing in a field gives a bright sky-blue key with green bounce from below.
  The probe re-bakes whenever the character has walked about 6 m, throttled so
  it never runs back to back. Captures taken before a world has finished
  streaming come back black and are rejected and retried rather than applied.
- **Grounding.** A world's invisible collider sits below the surface you can
  actually see, which is what makes a character look sunk into the road. On
  load, the app raycasts both the collider and the visible splat surface at a
  few points and measures the gap, repeating for a few seconds because
  low-detail splats read high until the world streams in. The settled value is
  saved per world and can always be overridden with `[` / `]`.
- **Stride.** Each locomotion clip is authored for a particular ground speed,
  and playing it at any other speed makes the feet skate. At load the app runs
  each clip in isolation and watches how fast the planted foot travels backwards
  under the body, which gives that speed directly — the walk cycle turns out to
  be authored for about 0.7 m/s. Playback rate is then derived from it, and the
  controller's walk speed is set so the stride covers the ground it travels.
  Walk and run are also phase-aligned when they blend, so their leg swings
  reinforce rather than cancel.
- **Arm pose.** Mint rigs characters from a T-pose, so retargeted arms sit
  much wider than the source clip intends — measured at 21–34° out from the
  torso across all three characters, in idle as well as in motion, which reads
  as a permanent shrug. After the animation poses the skeleton each frame, the
  upper arm and forearm are rotated back in about the character's forward axis.
  The spread is *scaled* rather than clamped to a limit: clamping parked every
  frame on the same angle, which flattened the arm's movement into a constant
  and looked pinned. Only the sideways component is touched, so the forward/back
  swing that carries the walk and run cycles is untouched. Tunable with `;` /
  `'`.
- **Shadow.** Splats cannot receive shadow maps, so the character gets a soft
  contact decal placed at the same corrected ground point as its feet, aligned
  to the ground normal, leaning away from the derived key light, and fading out
  as it jumps.

## Adding a new world or character

Generate the asset on [mint.gg](https://mint.gg) (or ask Claude to generate it
via Mint MCP into the same Mint Project), then sync it into the registry:

1. **World** — after the world generation succeeds, fetch its artifact manifest
   (`get_asset_artifact_manifest`, `asset_type: "world"`), save it to a temp
   JSON file, and run:

   ```bash
   node <mint-threejs-skills>/scripts/sync-mint-assets.mjs --project . --manifest /tmp/my-world.json --key world-my-place
   ```

2. **Character** — the model must be humanoid-riggable (generate it as a T-pose
   riggable character with empty hands). Rig it with
   `animate_generated_model` using the `basic_locomotion` set, wait for the
   batch, fetch `get_model_animation_artifact_manifest`, save it, and run the
   same sync command with a `character-...` key.

3. Reload the app — the new entry appears in the matching dropdown. No code
   changes needed.

Keys are stable and reusable: re-syncing the same key replaces that asset.

## Deploying

Pushing to `main` builds the site and publishes it to GitHub Pages via
`.github/workflows/deploy.yml`. Live at
<https://cloudylo001.github.io/change-character-world/>.

The site is served from a project subpath, so the build needs a base path.
The workflow passes the one GitHub reports; `vite.config.ts` falls back to
`/change-character-world/` locally and honours `BASE_PATH` if you deploy
somewhere else:

```bash
BASE_PATH=/ npm run build
```

Character GLBs are committed and served from the site (~62 MB), while splat
worlds stream from the Mint CDN at runtime, so they cost nothing in the repo.
Note that Mint bakes the full skinned mesh into every animation clip, which is
why a single character is ~20 MB. Uploaded assets stay in the visitor's own
browser and are never part of a deploy.

## Project layout

- `src/game/Game.ts` — orchestration: loading, swapping, update loop
- `src/world/MintWorld.ts` — Spark RAD splat + collider loading/disposal
- `src/systems/EnvironmentLight.ts` — world-derived light probe and key light
- `src/entities/ContactShadow.ts` — soft ground shadow decal
- `src/entities/Character.ts` — rigged GLB + locomotion animation states
- `src/core/PlayerController.ts` — kinematic movement, gravity, raycast ground
- `src/systems/ThirdPersonCamera.ts` — orbit/follow camera
- `src/ui/Overlay.ts` — status line + world/character switcher
- `src/ui/SettingsPanel.ts` — upload panel, asset list, Mint import queue
- `src/mint/library.ts` — IndexedDB store for uploaded assets
- `src/world/SplatGround.ts` — cached ground heights for collider-less worlds
- `src/assets/gltf-runtime.ts` — shared Draco-capable GLTF loader (required
  for all Mint GLBs)
- `mint-assets.json` — durable asset registry (worlds, characters, Mint
  Project association)
#   c h a n g e - c h a r a c t e r - w o r l d  
 