#!/usr/bin/env node
// Builds the fixtures the character-import end-to-end check needs, out of the
// shared locomotion clips that already ship in the repo. Nothing binary is
// committed — run this before `scripts/test-character-import.mjs`.
//
//   node scripts/make-test-fixtures.mjs
//
// Writes into artifacts/fixtures:
//   multi-take.glb           four animations in one file, sensibly named
//   takes.glb                the same four, named anim_00..anim_03
//   walk-rootmotion-cm.glb   the walk in centimetres, with real root motion
//   cube.obj / cube.stl      static meshes with no skeleton at all
//
// The three GLBs share one skeleton. Merging four documents would give four
// *copies* of it, and three.js would then dedupe the colliding node names to
// Hips_1, Hips_2 … which no longer bind to a character's real Hips — so the
// animations are copied channel by channel onto a single node graph instead.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';

const CLIPS = 'public/assets/clips';
const OUT = 'artifacts/fixtures';
/** Ground speed the root-motion fixture is authored to imply, in m/s. */
const ROOT_MOTION_SPEED = 1.4;
/** Every translation in the cm fixture is scaled by this. */
const CM_PER_METRE = 100;

const io = new NodeIO();

function copyAccessor(target, source, buffer) {
  return target
    .createAccessor()
    .setArray(source.getArray().slice())
    .setType(source.getType())
    .setBuffer(buffer);
}

/** Re-creates `animation` inside `target`, bound to `target`'s own nodes by name. */
function copyAnimation(target, animation, name, buffer) {
  const nodesByName = new Map(target.getRoot().listNodes().map((node) => [node.getName(), node]));
  const copy = target.createAnimation(name);
  for (const channel of animation.listChannels()) {
    const node = nodesByName.get(channel.getTargetNode()?.getName());
    const sampler = channel.getSampler();
    if (!node || !sampler) continue;
    const copiedSampler = target
      .createAnimationSampler()
      .setInput(copyAccessor(target, sampler.getInput(), buffer))
      .setOutput(copyAccessor(target, sampler.getOutput(), buffer))
      .setInterpolation(sampler.getInterpolation());
    copy.addSampler(copiedSampler);
    copy.addChannel(
      target
        .createAnimationChannel()
        .setTargetNode(node)
        .setTargetPath(channel.getTargetPath())
        .setSampler(copiedSampler),
    );
  }
  return copy;
}

async function buildMultiTake(names) {
  // The walk document supplies the skeleton every take is copied onto.
  const doc = await io.read(path.join(CLIPS, 'walk.glb'));
  const buffer = doc.getRoot().listBuffers()[0];
  doc.getRoot().listAnimations()[0].setName(names.walk);

  for (const [role, name] of Object.entries(names)) {
    if (role === 'walk') continue;
    const source = await io.read(path.join(CLIPS, `${role}.glb`));
    const animation = source.getRoot().listAnimations()[0];
    if (!animation) throw new Error(`${role}.glb has no animation`);
    copyAnimation(doc, animation, name, buffer);
  }
  return doc;
}

function channelDuration(animation) {
  let longest = 0;
  for (const channel of animation.listChannels()) {
    const times = channel.getSampler()?.getInput()?.getArray();
    if (times && times.length > 0) longest = Math.max(longest, times[times.length - 1]);
  }
  return longest;
}

/**
 * The realistic Mixamo case, which exercises unit rescaling and root-motion
 * stripping together: translations in centimetres, and hips that actually
 * travel forward over the cycle.
 */
async function buildRootMotionCm() {
  const doc = await io.read(path.join(CLIPS, 'walk.glb'));
  const animation = doc.getRoot().listAnimations()[0];
  const duration = channelDuration(animation);

  for (const channel of animation.listChannels()) {
    if (channel.getTargetPath() !== 'translation') continue;
    const output = channel.getSampler().getOutput();
    const values = output.getArray();
    for (let i = 0; i < values.length; i += 1) values[i] *= CM_PER_METRE;
    output.setArray(values);
  }

  const hips = animation
    .listChannels()
    .find(
      (channel) =>
        channel.getTargetPath() === 'translation' &&
        /hips?|pelvis|root/i.test(channel.getTargetNode()?.getName() ?? ''),
    );
  if (!hips) throw new Error('walk.glb has no hips translation channel to add root motion to');

  const sampler = hips.getSampler();
  const times = sampler.getInput().getArray();
  const values = sampler.getOutput().getArray();
  const span = times[times.length - 1] - times[0];
  const distance = ROOT_MOTION_SPEED * duration * CM_PER_METRE;
  for (let i = 0; i < times.length; i += 1) {
    const t = span > 0 ? (times[i] - times[0]) / span : 0;
    values[i * 3 + 2] -= t * distance;
  }
  sampler.getOutput().setArray(values);
  return { doc, expectedSpeed: ROOT_MOTION_SPEED, duration };
}

/**
 * The same walk on a skeleton whose bone names nothing can be talked into
 * matching, so the bind-rate gate has something real to reject.
 */
async function buildForeignRig() {
  const doc = await io.read(path.join(CLIPS, 'walk.glb'));
  for (const node of doc.getRoot().listNodes()) {
    node.setName(`zzq${node.getName()}`);
  }
  doc.getRoot().listAnimations()[0].setName('Walking');
  return doc;
}

function cubeObj() {
  const v = [
    [-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5],
    [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5],
  ];
  const faces = [
    [1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2],
    [2, 6, 7, 3], [3, 7, 8, 4], [4, 8, 5, 1],
  ];
  return [
    '# static cube — no skeleton, nothing can animate it',
    ...v.map(([x, y, z]) => `v ${x} ${y} ${z}`),
    ...faces.map((face) => `f ${face.join(' ')}`),
    '',
  ].join('\n');
}

function cubeStl() {
  // Binary STL: 80-byte header, uint32 triangle count, then 50 bytes each.
  const tris = [];
  const v = [
    [-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5],
    [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5],
  ];
  const quads = [
    [0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1],
    [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0],
  ];
  for (const [a, b, c, d] of quads) {
    tris.push([v[a], v[b], v[c]], [v[a], v[c], v[d]]);
  }
  const buffer = Buffer.alloc(84 + tris.length * 50);
  buffer.write('static cube fixture', 0);
  buffer.writeUInt32LE(tris.length, 80);
  tris.forEach((triangle, index) => {
    let offset = 84 + index * 50 + 12; // Leave the normal as zeroes.
    for (const point of triangle) {
      for (const component of point) {
        buffer.writeFloatLE(component, offset);
        offset += 4;
      }
    }
  });
  return buffer;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const named = await buildMultiTake({ idle: 'Idle', walk: 'Walking', run: 'Running', jump: 'Jump' });
  await writeFile(path.join(OUT, 'multi-take.glb'), await io.writeBinary(named));

  const anonymous = await buildMultiTake({
    idle: 'anim_00',
    walk: 'anim_01',
    run: 'anim_02',
    jump: 'anim_03',
  });
  await writeFile(path.join(OUT, 'takes.glb'), await io.writeBinary(anonymous));

  const rootMotion = await buildRootMotionCm();
  await writeFile(
    path.join(OUT, 'walk-rootmotion-cm.glb'),
    await io.writeBinary(rootMotion.doc),
  );

  await writeFile(
    path.join(OUT, 'foreign-rig-walk.glb'),
    await io.writeBinary(await buildForeignRig()),
  );

  await writeFile(path.join(OUT, 'cube.obj'), cubeObj());
  await writeFile(path.join(OUT, 'cube.stl'), cubeStl());

  await writeFile(
    path.join(OUT, 'fixtures.json'),
    `${JSON.stringify(
      {
        rootMotion: {
          expectedSpeed: rootMotion.expectedSpeed,
          duration: rootMotion.duration,
          unitScale: CM_PER_METRE,
        },
      },
      null,
      2,
    )}\n`,
  );

  console.log(`Wrote fixtures into ${OUT}:`);
  console.log('  multi-take.glb          4 takes named Idle/Walking/Running/Jump');
  console.log('  takes.glb               the same 4, named anim_00..anim_03');
  console.log(
    `  walk-rootmotion-cm.glb  x${CM_PER_METRE} translations, ` +
      `${rootMotion.expectedSpeed} m/s of root motion over ${rootMotion.duration.toFixed(2)}s`,
  );
  console.log('  foreign-rig-walk.glb    the walk on unmatchable bone names');
  console.log('  cube.obj / cube.stl     static, no skeleton');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
