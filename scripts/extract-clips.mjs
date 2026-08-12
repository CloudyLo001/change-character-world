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
//   node scripts/extract-clips.mjs --source public/assets/mint/character-knight
//
// Writes public/assets/clips/<role>.glb

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';

const ROLES = ['idle', 'walk', 'run', 'jump'];
const DEFAULTS = {
  source: 'public/assets/mint/character-knight',
  out: 'public/assets/clips',
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') options.source = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/extract-clips.mjs [--source DIR] [--out DIR]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const io = new NodeIO();

  for (const role of ROLES) {
    const input = path.join(args.source, `clip-${role}-animation_glb.glb`);
    const bytes = await readFile(input).catch(() => null);
    if (!bytes) {
      console.warn(`skipped ${role}: ${input} not found`);
      continue;
    }

    const document = await io.readBinary(new Uint8Array(bytes));
    const root = document.getRoot();

    const animations = root.listAnimations();
    if (animations.length === 0) {
      console.warn(`skipped ${role}: no animation in ${input}`);
      continue;
    }
    const expectedChannels = animations[0].listChannels().length;

    // Detach the renderable parts. The bones stay, because the animation
    // channels target them and prune() keeps anything still referenced.
    for (const node of root.listNodes()) {
      node.setMesh(null);
      node.setSkin(null);
    }
    for (const mesh of root.listMeshes()) mesh.dispose();
    for (const skin of root.listSkins()) skin.dispose();
    await document.transform(prune());

    const survivingChannels = root.listAnimations()[0]?.listChannels().length ?? 0;
    if (survivingChannels !== expectedChannels) {
      throw new Error(
        `${role}: animation lost channels during strip (${expectedChannels} -> ${survivingChannels})`,
      );
    }

    const output = path.join(args.out, `${role}.glb`);
    const packed = await io.writeBinary(document);
    await writeFile(output, packed);

    const before = bytes.length;
    const after = packed.length;
    console.log(
      `${role}: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e3).toFixed(0)} KB ` +
        `(${survivingChannels} channels)`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
