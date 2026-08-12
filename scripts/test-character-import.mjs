#!/usr/bin/env node
// End-to-end check of the guided character import: multi-clip files, name-free
// clips classified by motion, centimetre rescaling, root-motion stripping, the
// no-skeleton path, and the v1 -> v2 library migration.
//
//   node scripts/make-test-fixtures.mjs
//   node scripts/test-character-import.mjs
//
// Expects a dev server to already be listening (npm run dev).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const URL = process.env.URL ?? 'http://127.0.0.1:5188/';
const FIXTURES = path.resolve('artifacts/fixtures');
const MODEL = path.resolve('public/assets/mint/character-android/rigged_character_glb.glb');

const fixture = (name) => path.join(FIXTURES, name);

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function openWizard(page) {
  const panelOpen = await page.evaluate(
    () => !document.querySelector('#settings-panel')?.classList.contains('is-hidden'),
  );
  if (!panelOpen) await page.click('#settings-open');
  await page.click('#character-import-open');
  await page.waitForSelector('#import-wizard:not(.is-hidden)');
}

async function closeWizard(page) {
  await page.click('#import-wizard-close');
  await page.waitForSelector('#import-wizard.is-hidden', { state: 'attached' });
}

async function listCharacterKeys(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#character-select option')].map((option) => option.value),
  );
}

/** Runs the whole wizard and returns the key of the character it created. */
async function importCharacter(page, { model, clips = [], roles = null }) {
  const before = await listCharacterKeys(page);
  await openWizard(page);
  await page.setInputFiles('#import-model', model);
  await page.waitForSelector('#import-next, #import-no-skeleton', { timeout: 60_000 });

  let fileSummaries = [];
  if (clips.length > 0) {
    await page.click('#import-next');
    await page.waitForSelector('#import-clips', { state: 'attached' });
    await page.setInputFiles('#import-clips', clips);
    await page.waitForSelector('#import-clip-files li', { timeout: 60_000 });
    fileSummaries = await page.evaluate(() =>
      [...document.querySelectorAll('#import-clip-files .settings-row-name')].map(
        (element) => element.textContent ?? '',
      ),
    );
    await page.click('#import-next');
    await page.waitForSelector('#import-clip-rows .clip-row', { timeout: 120_000 });
    await page.waitForFunction(
      () => document.querySelector('#import-wizard-status')?.dataset.state !== 'busy',
      null,
      { timeout: 120_000 },
    );
  }

  const assigned = await page.evaluate(() =>
    [...document.querySelectorAll('.clip-row')].map((row) => ({
      file: row.dataset.clipFile ?? '',
      name: row.querySelector('.clip-row-name')?.textContent ?? '',
      facts: row.querySelector('.clip-row-facts')?.textContent ?? '',
      role: row.querySelector('.clip-role-select')?.value ?? '',
    })),
  );

  // Forced by clip name, never by row index: the model's own embedded
  // animation is a candidate too, so index 0 is not the first uploaded clip.
  for (const [match, role] of Object.entries(roles ?? {})) {
    const applied = await page.evaluate(
      ({ match: m, role: r }) => {
        const row = [...document.querySelectorAll('.clip-row')].find(
          (candidate) =>
            (candidate.dataset.clipFile ?? '').includes(m) ||
            (candidate.querySelector('.clip-row-name')?.textContent ?? '').includes(m),
        );
        const select = row?.querySelector('.clip-role-select');
        if (!select) return false;
        select.value = r;
        select.dispatchEvent(new Event('change'));
        return true;
      },
      { match, role },
    );
    if (!applied) throw new Error(`No clip row matching "${match}" to force to ${role}`);
  }

  const saveSelector = clips.length > 0 ? '#import-save' : '#import-save-unplayable, #import-next';
  await page.click(saveSelector);
  await page.waitForFunction(
    (known) =>
      [...document.querySelectorAll('#character-select option')].some(
        (option) => !known.includes(option.value),
      ),
    before,
    { timeout: 60_000 },
  );
  const key = await page.evaluate(
    (known) =>
      [...document.querySelectorAll('#character-select option')]
        .map((option) => option.value)
        .find((value) => !known.includes(value)) ?? null,
    before,
  );
  return { key, assigned, fileSummaries };
}

async function selectCharacter(page, key) {
  await page.evaluate((value) => {
    const select = document.querySelector('#character-select');
    select.value = value;
    select.dispatchEvent(new Event('change'));
  }, key);
  await page.waitForFunction(
    (value) => window.__THREE_GAME_DIAGNOSTICS__?.character === value,
    key,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(600);
}

async function boot(page) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, {
    timeout: 30_000,
  });
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__.setCaptureMode(true);
    window.__THREE_GAME_TEST_HOOKS__.hideDebugUi(true);
  });
}

/**
 * Writes a pre-v2 character record into a freshly created version-1 database.
 *
 * Seeded from a page that does not load the app — a stylesheet URL is
 * same-origin and script-free — because the running app holds an open
 * connection that would block deleting the database.
 */
async function seedLegacyLibrary(page, clipFileName, clipBytes, modelBytes, modelName) {
  await page.goto(`${URL}src/styles.css`, { waitUntil: 'domcontentloaded' });
  return page.evaluate(
    async ({ clipFileName, clipBytes, modelBytes, modelName }) => {
      await new Promise((resolve) => {
        const remove = indexedDB.deleteDatabase('mint-playground-library');
        remove.onsuccess = resolve;
        remove.onerror = resolve;
        remove.onblocked = resolve;
      });
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open('mint-playground-library', 1);
        open.onupgradeneeded = () => {
          const result = open.result;
          result.createObjectStore('files', { keyPath: 'id' });
          result.createObjectStore('assets', { keyPath: 'key' });
          result.createObjectStore('imports', { keyPath: 'id' });
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const tx = db.transaction(['files', 'assets'], 'readwrite');
      tx.objectStore('files').put({
        id: 'file-legacy-model',
        name: modelName,
        size: modelBytes.length,
        blob: new Blob([new Uint8Array(modelBytes)]),
      });
      tx.objectStore('files').put({
        id: 'file-legacy-walk',
        name: clipFileName,
        size: clipBytes.length,
        blob: new Blob([new Uint8Array(clipBytes)]),
      });
      // Exactly the v1 shape: no id, no clipIndex, no measurements, no schema.
      tx.objectStore('assets').put({
        key: 'character-legacy-v1',
        kind: 'character',
        label: 'Legacy V1',
        createdAt: 1,
        bytes: modelBytes.length + clipBytes.length,
        character: {
          modelFileId: 'file-legacy-model',
          modelFileName: modelName,
          clips: [{ role: 'walk', fileId: 'file-legacy-walk', fileName: clipFileName }],
        },
      });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return true;
    },
    { clipFileName, clipBytes, modelBytes, modelName },
  );
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  // The legacy-library seed deliberately navigates to a script-free 404 page,
  // whose failed document request is the browser's own console error, not the
  // app's. Nothing else is exempt.
  let seeding = false;
  page.on('console', (message) => {
    // The bind-rate refusal is deliberate and logged as a warning, not an error.
    if (message.type() === 'error' && !seeding) errors.push(message.text());
  });
  page.on('pageerror', (error) => {
    if (!seeding) errors.push(String(error));
  });

  const expectations = JSON.parse(await readFile(fixture('fixtures.json'), 'utf8'));

  await boot(page);

  // --- multiple clips inside one file -------------------------------------
  const multi = await importCharacter(page, { model: MODEL, clips: [fixture('multi-take.glb')] });
  check('multi-take: four takes read from one file',
    multi.fileSummaries.some((summary) => /multi-take\.glb — 4 takes found/.test(summary)),
    multi.fileSummaries.join(' | '));
  await selectCharacter(page, multi.key);
  let clips = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.describeClips());
  const multiRoles = (clips ?? []).map((clip) => clip.role).sort().join(',');
  check('multi-take: all four roles come from the file', multiRoles === 'idle,jump,run,walk',
    multiRoles);
  check('multi-take: nothing borrowed',
    (clips ?? []).every((clip) => clip.source === 'own'),
    (clips ?? []).map((clip) => `${clip.role}:${clip.source}`).join(' '));

  // --- classification with no usable names --------------------------------
  const takes = await importCharacter(page, { model: MODEL, clips: [fixture('takes.glb')] });
  await selectCharacter(page, takes.key);
  clips = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.describeClips());
  const takeRoles = (clips ?? []).map((clip) => clip.role).sort().join(',');
  check('takes: roles recovered from motion despite anim_00..03 names',
    takeRoles === 'idle,jump,run,walk', takeRoles);

  // --- centimetres + root motion ------------------------------------------
  const rootMotion = await importCharacter(page, {
    model: MODEL,
    clips: [fixture('walk-rootmotion-cm.glb')],
    roles: { 'walk-rootmotion-cm': 'walk' },
  });
  await selectCharacter(page, rootMotion.key);
  clips = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.describeClips());
  const walkClip = (clips ?? []).find((clip) => clip.role === 'walk');
  check('root motion: centimetre units detected',
    walkClip?.unitScale === expectations.rootMotion.unitScale,
    `unitScale ${walkClip?.unitScale}`);
  check('root motion: detected and stripped', walkClip?.rootMotion === true);
  const speed = await page.evaluate(
    () => window.__THREE_GAME_DIAGNOSTICS__.grounding.clipSpeeds.walk,
  );
  const expected = expectations.rootMotion.expectedSpeed;
  check('root motion: authored speed read off the travel',
    Math.abs(speed - expected) / expected < 0.25,
    `${speed.toFixed(2)} m/s vs ${expected} expected`);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setInputYaw(0));
  await page.keyboard.down('w');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.step(180, 1 / 60));
  const hips = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.hipOffset());
  await page.keyboard.up('w');
  const drift = hips ? Math.hypot(hips.x, hips.z) : Number.NaN;
  check('root motion: body stays over the controller', drift < 0.15,
    `hips ${drift.toFixed(3)} m off centre`);

  // --- a clip from a rig that shares no bone names -------------------------
  const foreign = await importCharacter(page, {
    model: MODEL,
    clips: [fixture('foreign-rig-walk.glb')],
    roles: { 'foreign-rig-walk': 'walk' },
  });
  const foreignRow = foreign.assigned.find((row) => row.file.includes('foreign-rig-walk'));
  check('foreign rig: flagged as a different rig in the review',
    /different rig/.test(foreignRow?.facts ?? ''), foreignRow?.facts ?? 'no row');
  await selectCharacter(page, foreign.key);
  const borrowed = await page.evaluate(() =>
    (window.__THREE_GAME_TEST_HOOKS__.describeClips() ?? [])
      .filter((clip) => clip.source === 'borrowed')
      .map((clip) => clip.role),
  );
  check('foreign rig: walk falls back to a borrowed clip', borrowed.includes('walk'),
    `borrowed ${borrowed.join(', ') || 'nothing'}`);

  // --- meshes with no skeleton --------------------------------------------
  for (const name of ['cube.obj', 'cube.stl']) {
    const before = await listCharacterKeys(page);
    await openWizard(page);
    await page.setInputFiles('#import-model', fixture(name));
    await page.waitForSelector('#import-no-skeleton', { timeout: 60_000 });
    await page.click('#import-save-unplayable');
    await page.waitForFunction(
      (known) =>
        [...document.querySelectorAll('#character-select option')].some(
          (option) => !known.includes(option.value),
        ),
      before,
      { timeout: 60_000 },
    );
    const marked = await page.evaluate(
      (known) =>
        [...document.querySelectorAll('#character-select option')]
          .filter((option) => !known.includes(option.value))
          .every((option) => option.textContent.includes('no skeleton')),
      before,
    );
    check(`${name}: accepted and marked unplayable`, marked);
  }

  // --- preview lifecycle ---------------------------------------------------
  for (let i = 0; i < 5; i += 1) {
    await openWizard(page);
    await page.setInputFiles('#import-model', MODEL);
    await page.waitForSelector('#import-next', { timeout: 60_000 });
    await page.click('#import-next');
    await page.setInputFiles('#import-clips', [fixture('multi-take.glb')]);
    await page.waitForSelector('#import-clip-files li', { timeout: 60_000 });
    await page.click('#import-next');
    await page.waitForSelector('#clip-preview canvas', { timeout: 120_000 });
    await closeWizard(page);
  }
  const aliveAfterCycles = await page.evaluate(
    () => Boolean(window.__THREE_GAME_DIAGNOSTICS__?.renderer),
  );
  check('preview: five open/close cycles leave the game renderer alive', aliveAfterCycles);
  check('preview: no WebGL context was lost',
    !errors.some((error) => /context.*lost/i.test(error)));

  // --- v1 library migration ------------------------------------------------
  const modelBytes = [...new Uint8Array(await readFile(MODEL))];
  const clipBytes = [...new Uint8Array(await readFile(path.join('public/assets/clips/walk.glb')))];
  seeding = true;
  await seedLegacyLibrary(page, 'walk.glb', clipBytes, modelBytes, 'rigged_character_glb.glb');
  const migrationErrors = errors.length;
  await boot(page);
  seeding = false;
  await selectCharacter(page, 'character-legacy-v1');
  clips = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.describeClips());
  const legacyWalk = (clips ?? []).find((clip) => clip.role === 'walk');
  check('v1 migration: the legacy character still loads', Boolean(legacyWalk));
  check('v1 migration: its own walk survived the upgrade rather than being borrowed',
    legacyWalk?.source === 'own', `source ${legacyWalk?.source}`);
  // A migrated record carries no stored measurement, so the speed has to come
  // from the runtime foot-travel pass — which is exactly how v1 behaved.
  const legacySpeed = await page.evaluate(
    () => window.__THREE_GAME_DIAGNOSTICS__.grounding.clipSpeeds.walk,
  );
  check('v1 migration: walk speed re-measured at load', legacySpeed > 0.3 && legacySpeed < 9,
    `${legacySpeed.toFixed(2)} m/s`);
  check('v1 migration: no errors during the upgrade', errors.length === migrationErrors,
    errors.slice(migrationErrors).join(' | '));

  await browser.close();

  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`console errors: ${errors.length}`);
  for (const error of errors.slice(0, 8)) console.error(`  ${error}`);
  if (failed.length > 0 || errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
