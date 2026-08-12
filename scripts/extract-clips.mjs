#!/usr/bin/env node
// Mint bakes a full copy of the character mesh into every animation clip GLB —
// a walk clip is 4.7 MB of which roughly 50 KB is the animation. The runtime
// reads only `animations[0]` and throws the scene away, so this strips each
// clip down to its skeleton and animation.
//
// The result is both far smaller and reusable: an animation-only clip binds to
// any skeleton with matching bone names, so uploaded characters that arrive
// with no animation can borrow these.
//
// Two modes:
//
//   node scripts/extract-clips.mjs --source public/assets/mint/character-knight
//     Builds the shared borrowable set, writing public/assets/clips/<role>.glb.
//
//   node scripts/extract-clips.mjs --in-place public/assets/mint/character-plumber
//     Shrinks one synced character's own clips where they sit, keeping their
//     filenames so mint-assets.json needs no edit. A four-clip character comes
//     down from ~18 MB to a few hundred KB, which is the difference between a
//     character being committable and not.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';

const ROLES = ['idle', 'walk', 'run', 'jump'];
const DEFAULTS = {
  source: 'public/assets/mint/character-knight',
  out: 'public/assets/clips',
  inPlace: null,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') options.source = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--in-place') options.inPlace = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/extract-clips.mjs [--source DIR] [--out DIR]\n' +
          '       node scripts/extract-clips.mjs --in-place CHARACTER_DIR',
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

/**
 * Detaches the renderable parts of a clip GLB. The bones stay: the animation
 * channels target them and prune() keeps anything still referenced.
 */
async function stripClip(io, bytes, label) {
  const document = await io.readBinary(new Uint8Array(bytes));
  const root = document.getRoot();

  const animations = root.listAnimations();
  if (animations.length === 0) return null;
  const expectedChannels = animations.reduce(
    (total, animation) => total + animation.listChannels().length,
    0,
  );

  for (const node of root.listNodes()) {
    node.setMesh(null);
    node.setSkin(null);
  }
  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const skin of root.listSkins()) skin.dispose();
  await document.transform(prune());

  const survivingChannels = root
    .listAnimations()
    .reduce((total, animation) => total + animation.listChannels().length, 0);
  if (survivingChannels !== expectedChannels) {
    throw new Error(
      `${label}: animation lost channels during strip (${expectedChannels} -> ${survivingChannels})`,
    );
  }
  return { packed: await io.writeBinary(document), channels: survivingChannels };
}

function report(label, before, after, channels) {
  console.log(
    `${label}: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e3).toFixed(0)} KB ` +
      `(${channels} channels)`,
  );
}

async function shrinkInPlace(io, directory) {
  const entries = await readdir(directory);
  const clips = entries.filter((name) => /^clip-.*\.glb$/i.test(name));
  if (clips.length === 0) {
    console.warn(`no clip GLBs found in ${directory}`);
    return;
  }
  let saved = 0;
  for (const name of clips) {
    const file = path.join(directory, name);
    const bytes = await readFile(file);
    const result = await stripClip(io, bytes, name);
    if (!result) {
      console.warn(`skipped ${name}: no animation`);
      continue;
    }
    // Already stripped clips are left alone rather than rewritten.
    if (result.packed.length >= bytes.length) {
      console.log(`${name}: already stripped`);
      continue;
    }
    await writeFile(file, result.packed);
    saved += bytes.length - result.packed.length;
    report(name, bytes.length, result.packed.length, result.channels);
  }
  console.log(`saved ${(saved / 1e6).toFixed(1)} MB in ${directory}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const io = new NodeIO();

  if (args.inPlace) {
    await shrinkInPlace(io, args.inPlace);
    return;
  }

  await mkdir(args.out, { recursive: true });
  for (const role of ROLES) {
    const input = path.join(args.source, `clip-${role}-animation_glb.glb`);
    const bytes = await readFile(input).catch(() => null);
    if (!bytes) {
      console.warn(`skipped ${role}: ${input} not found`);
      continue;
    }
    const result = await stripClip(io, bytes, role);
    if (!result) {
      console.warn(`skipped ${role}: no animation in ${input}`);
      continue;
    }
    await writeFile(path.join(args.out, `${role}.glb`), result.packed);
    report(role, bytes.length, result.packed.length, result.channels);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
