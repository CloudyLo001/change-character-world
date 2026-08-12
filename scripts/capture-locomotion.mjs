#!/usr/bin/env node
// Renders the playground headlessly and captures a gait cycle as separate PNGs,
// so a walk or run can actually be looked at frame by frame instead of being
// judged from numbers. Uses Playwright's chromium directly rather than the test
// runner, because playwright.config.ts starts its own dev server with pnpm.
//
//   node scripts/capture-locomotion.mjs --character character-knight --mode run
//
// Expects a dev server to already be listening (npm run dev).

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const DEFAULTS = {
  url: 'http://127.0.0.1:5188/',
  out: 'artifacts/locomotion',
  character: 'character-knight',
  world: null,
  mode: 'walk',
  frames: 10,
  interval: 90,
  settle: 2500,
  // Side-on and slightly above: the angle that shows stride length, foot plant
  // and arm swing at once.
  yaw: Math.PI / 2,
  pitch: 0.12,
  distance: 3.4,
  width: 900,
  height: 700,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === '--url') options.url = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--character') options.character = next();
    else if (arg === '--world') options.world = next();
    else if (arg === '--mode') options.mode = next();
    else if (arg === '--frames') options.frames = Number.parseInt(next(), 10);
    else if (arg === '--interval') options.interval = Number.parseInt(next(), 10);
    else if (arg === '--settle') options.settle = Number.parseInt(next(), 10);
    else if (arg === '--yaw') options.yaw = Number.parseFloat(next());
    else if (arg === '--pitch') options.pitch = Number.parseFloat(next());
    else if (arg === '--distance') options.distance = Number.parseFloat(next());
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/capture-locomotion.mjs [--character K] [--mode walk|run|idle]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 1,
  });

  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(args.url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#game-canvas');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, {
    timeout: 20_000,
  });

  // Engage capture mode first: a splat world drawn through software GL starves
  // the main thread badly enough that a character GLB never finishes parsing.
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks.setCaptureMode(true);
    hooks.hideDebugUi(true);
  });

  // Pick the character (and world) through the real switcher so the capture
  // exercises the same path a user does.
  await page.evaluate(
    ({ character, world }) => {
      const select = (id, value) => {
        if (!value) return;
        const element = document.querySelector(id);
        if (!element) return;
        element.value = value;
        element.dispatchEvent(new Event('change'));
      };
      select('#world-select', world);
      select('#character-select', character);
    },
    { character: args.character, world: args.world },
  );

  // Wait for the requested character to actually be the live one, otherwise the
  // capture can straddle a swap.
  try {
    await page.waitForFunction(
      (expected) => window.__THREE_GAME_DIAGNOSTICS__?.character === expected,
      args.character,
      { timeout: 45_000 },
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      character: window.__THREE_GAME_DIAGNOSTICS__?.character ?? null,
      world: window.__THREE_GAME_DIAGNOSTICS__?.world ?? null,
      frame: window.__THREE_GAME_DIAGNOSTICS__?.frame ?? null,
      status: document.querySelector('#status-line')?.textContent ?? null,
      options: [...document.querySelectorAll('#character-select option')].map((o) => o.value),
    }));
    console.error('character never became active:', JSON.stringify(state, null, 2));
    for (const message of errors.slice(0, 8)) console.error(`  console error: ${message}`);
    throw error;
  }
  await page.waitForTimeout(args.settle);
  await page.evaluate(
    ({ yaw, pitch, distance }) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__;
      hooks.hideDebugUi(true);
      hooks.setCaptureMode(true);
      // Walk along +Z while the camera watches from the side.
      hooks.setInputYaw(0);
      hooks.setCameraPose(yaw, pitch, distance);
    },
    args,
  );

  if (args.mode !== 'idle') {
    await page.keyboard.down('w');
    if (args.mode === 'run') await page.keyboard.down('Shift');
    // Let the controller reach steady speed and the blend settle before capture.
    await page.waitForTimeout(1800);
    await page.evaluate(
      ({ yaw, pitch, distance }) =>
        window.__THREE_GAME_TEST_HOOKS__.setCameraPose(yaw, pitch, distance),
      args,
    );
  }

  const captured = [];
  for (let frame = 0; frame < args.frames; frame += 1) {
    const name = `${args.character}-${args.mode}-${String(frame).padStart(2, '0')}.png`;
    const file = path.join(args.out, name);
    // Viewport rather than element capture: an element screenshot waits for the
    // node to hold still, which a canvas animating every frame never does.
    await page.screenshot({ path: file });
    captured.push(file);
    await page.waitForTimeout(args.interval);
  }

  const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__ ?? null);
  if (args.mode !== 'idle') {
    await page.keyboard.up('w');
    if (args.mode === 'run') await page.keyboard.up('Shift');
  }

  const report = {
    character: args.character,
    mode: args.mode,
    frames: captured,
    speed: diagnostics?.player?.speed ?? null,
    armSpread: diagnostics?.grounding?.armSpread ?? null,
    clipSpeeds: diagnostics?.grounding?.clipSpeeds ?? null,
    errors,
  };
  await writeFile(
    path.join(args.out, `${args.character}-${args.mode}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );

  await browser.close();

  console.log(`captured ${captured.length} frames -> ${args.out}`);
  console.log(`speed=${report.speed?.toFixed?.(2) ?? 'n/a'} errors=${errors.length}`);
  if (errors.length > 0) {
    for (const error of errors.slice(0, 5)) console.error(`  console error: ${error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
