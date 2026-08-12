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
| Drag on the canvas | Orbit the camera (cancels auto-orbit) |
| Mouse wheel | Zoom |
| `O` | Toggle the constant camera orbit |
| `Q` / `E` | Orbit left/right; press the same key again to speed it up |
| `[` / `]` | Lower/raise the character's ground height (per world, saved) |
| `,` / `.` | Dim/brighten the character's lighting (saved) |
| `;` / `'` | Loosen/tighten how close the arms sit to the body (saved) |
| `L` | Re-bake the world light probe at the current spot |
| `H` | Hide/show all UI (for clean recording) |

**The constant camera orbit.** `O` starts the camera circling the character and
keeps it circling while you walk, run and jump. `Q` and `E` set the direction;
pressing the active direction again winds the speed up a step, from a 25-second
lap down to about 4 seconds, so one key doubles as the speed control. Any drag
on the canvas takes the camera back and switches the orbit off.

Movement stays keyed to the angle the camera held when the orbit started.
`W A S D` is normally camera-relative, so a rotating camera would rotate the
meaning of "forward" with it and a held `W` would walk the character in a
circle; freezing the basis means the character walks a straight line while the
camera sweeps around it, which is the shot this exists for.

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
- **Character (guided)** — the recommended path, and the one to use for a
  character you rigged and animated in Mint. Accepts `.glb`, `.gltf`, `.fbx`,
  `.obj` and `.stl`, and walks you through three steps:

  1. Pick the model. It reports the format, triangle count and bone count. A
     mesh with no skeleton (any `.obj`/`.stl`, and plenty of `.glb`s) is told so
     plainly and can be saved as unplayable or queued for rigging in Mint —
     nothing can animate it until it has bones.
  2. Add its animation files, as many as you like. **Every clip inside every
     file is read**, so a Mint animation batch or a Mixamo pack exported as one
     file gives you all of its takes, not just the first.
  3. Review. Each clip is retargeted onto your character's actual skeleton and
     then measured — how fast it travels, how much the hips bob, whether the
     feet leave the ground — and a role is proposed from all three of the clip's
     internal name, the filename and that motion. So a file called `anim_01.glb`
     holding a clip named `Walking` is still recognised, and so is one whose
     name says nothing at all. Click any row to play it on your character in the
     preview, and change any role from its dropdown. Clips that barely bind to
     your skeleton are flagged red and left out by default.

  Along the way it corrects two things that otherwise break an import silently:
  clips authored in centimetres (Mixamo's default) are rescaled, and clips
  carrying root motion have the forward drift removed, since the controller owns
  position — the travel is kept as the clip's authored ground speed, which is a
  better reading than the foot-travel estimate.

- **Quick add a character** — the old path: one clip file per role, matched by
  filename, no review. Faster when you already know your filenames are right.

Any locomotion role you do not supply is borrowed from the shared clip set in
`public/assets/clips/`, so a character uploaded with no animation at all still
walks. A clip that does not bind to the skeleton is rejected and falls back to
borrowing rather than freezing the character.

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
- **Characters** are a `rigged_character` GLB under
  `public/assets/mint/<key>/`. Animation comes from the shared clip set in
  `public/assets/clips/` unless a character ships its own; for registry entries,
  clip roles (idle / walk / run / jump) are matched from filenames. Uploaded
  characters instead store a role per *clip*, with the file it lives in and its
  index inside that file, which is what lets one file supply several roles.
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

## Uploading a character that has no animation

An animation track binds to a bone **by name**, so a clip authored for one rig
plays on any skeleton using the same bone names. Upload a rigged character on
its own and it borrows the shared locomotion set immediately — no rigging step,
no credits. The panel and the status line say when animation is borrowed rather
than the character's own, and a badly-matched skeleton is rejected instead of
being animated half-way.

Two things worth knowing:

- **Mint cannot rig a file you upload.** `animate_generated_model` takes a Mint
  asset ID; there is no way to push a file back into Mint. What it *can* do is
  rig and animate an asset already in your account, even one with no skeleton —
  that is how the built-in characters were made. So the route for a Mint
  character is its link, not its file. The **Rig in Mint** button on each
  uploaded character copies a ready-made request for exactly that, including
  the filename, which carries the Mint asset slug.
- **A plain mesh with no skeleton cannot be animated by anything.** Mint's
  ordinary model download is unrigged. It loads so you can look at it and is
  clearly marked `no skeleton, cannot be animated`; rigging it in Mint is the
  fix.

The shared clips are produced by `scripts/extract-clips.mjs`, which strips the
character mesh Mint bakes into every clip file — a 4.7 MB walk clip becomes
72 KB, and the same clips then serve every character.

## Checking the import path

Both end-to-end checks drive a real browser against a running dev server, so
start `npm run dev` first.

```bash
npm run test:import
```

Generates fixtures into `artifacts/fixtures` (nothing binary is committed) and
runs `scripts/test-character-import.mjs` over them: a four-take file, the same
takes renamed `anim_00..03` so only motion can identify them, a walk in
centimetres with real root motion, a clip from a rig sharing no bone names,
`.obj`/`.stl` meshes with no skeleton, five wizard open/close cycles to prove
the preview releases its WebGL context, and a version-1 library seeded by hand
to prove the schema migration keeps old uploads working.

```bash
npm run test:borrow
```

The narrower regression check: upload a rigged character with no clips at all
and confirm it ends up walking on borrowed animation.

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

Character GLBs are committed and served from the site (~13 MB — one mesh each
plus ~210 KB of shared clips), while splat worlds stream from the Mint CDN at
runtime, so they cost nothing in the repo. Uploaded assets stay in the visitor's
own browser and are never part of a deploy.

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
- `src/ui/CharacterImportWizard.ts` — guided import: parse, measure, review
- `src/ui/ClipPreview.ts` — the wizard's own small renderer for auditioning clips
- `src/assets/model-loading.ts` — one loader for glb/gltf/fbx/obj/stl
- `src/animation/clip-fit.ts` — retargeting, unit rescale, root-motion removal
- `src/animation/ClipHarness.ts` — headless clip measurement (speed, bob, air time)
- `src/animation/clip-classify.ts` — role assignment from name + filename + motion
- `src/mint/library.ts` — IndexedDB store for uploaded assets
- `src/world/SplatGround.ts` — cached ground heights for collider-less worlds
- `src/assets/gltf-runtime.ts` — shared Draco-capable GLTF loader (required
  for all Mint GLBs)
- `mint-assets.json` — durable asset registry (worlds, characters, Mint
  Project association)
#   c h a n g e - c h a r a c t e r - w o r l d  
 