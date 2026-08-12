#!/usr/bin/env node
// End-to-end check of the "uploaded character has no animation" path: uploads a
// rigged character GLB on its own, with no clip files, and verifies it ends up
// walking on borrowed animation.
//
//   node scripts/test-upload-borrow.mjs
//
// Expects a dev server to already be listening (npm run dev).

import path from 'node:path';
import { chromium } from '@playwright/test';

const URL = process.env.URL ?? 'http://127.0.0.1:5188/';
const MODEL = path.resolve('public/assets/mint/character-android/rigged_character_glb.glb');

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, {
    timeout: 20_000,
  });
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__.setCaptureMode(true);
    window.__THREE_GAME_TEST_HOOKS__.hideDebugUi(true);
  });

  // Uploaded assets get the same `character-` key prefix as registry ones, so
  // identify the new entry by diffing the list rather than by name.
  const existing = await page.evaluate(() =>
    [...document.querySelectorAll('#character-select option')].map((option) => option.value),
  );

  await page.click('#settings-open');
  await page.setInputFiles('#upload-character', [MODEL]);

  await page.waitForFunction(
    (known) =>
      [...document.querySelectorAll('#character-select option')].some(
        (option) => !known.includes(option.value),
      ),
    existing,
    { timeout: 60_000 },
  );
  const uploadedKey = await page.evaluate(
    (known) =>
      [...document.querySelectorAll('#character-select option')]
        .map((option) => option.value)
        .find((value) => !known.includes(value)) ?? null,
    existing,
  );

  await page.evaluate((key) => {
    const select = document.querySelector('#character-select');
    select.value = key;
    select.dispatchEvent(new Event('change'));
  }, uploadedKey);

  await page.waitForFunction(
    (key) => window.__THREE_GAME_DIAGNOSTICS__?.character === key,
    uploadedKey,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1500);

  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__.setInputYaw(0);
    window.__THREE_GAME_TEST_HOOKS__.setCameraPose(-1.5708, 0.12, 3.4);
  });
  await page.keyboard.down('w');
  await page.waitForTimeout(1800);

  const before = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__.grounding.armSpread);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__.grounding.armSpread);
  const status = await page.evaluate(
    () => document.querySelector('#status-line')?.textContent ?? '',
  );
  const speed = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__.player.speed);

  for (let frame = 0; frame < 8; frame += 1) {
    await page.screenshot({
      path: path.join('artifacts/locomotion', `uploaded-walk-${String(frame).padStart(2, '0')}.png`),
    });
    await page.waitForTimeout(90);
  }
  await page.keyboard.up('w');
  await browser.close();

  // A borrowed clip that is actually driving the skeleton makes the arm angle
  // change between samples; a frozen bind pose would not.
  const animating = Math.abs(before.leftBefore - after.leftBefore) > 0.5;
  console.log(`uploaded key: ${uploadedKey}`);
  console.log(`status: ${status}`);
  console.log(`speed: ${speed.toFixed(2)}  arm angle moving: ${animating}`);
  console.log(`console errors: ${errors.length}`);
  for (const error of errors.slice(0, 5)) console.error(`  ${error}`);
  if (!animating || errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
