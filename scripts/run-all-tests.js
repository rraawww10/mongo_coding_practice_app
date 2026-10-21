#!/usr/bin/env node
'use strict';

/**
 * Runs every automated test suite and prints one summary:
 *   backend unit (mocks only) · backend integration (real local mongod) · backend e2e (HTTP) · frontend (Vitest)
 *
 *   node scripts/run-all-tests.js                 # everything
 *   node scripts/run-all-tests.js --only unit,e2e # subset: unit, integration, e2e, frontend
 *   node scripts/run-all-tests.js --coverage      # also writes coverage reports
 *
 * Exit codes: 0 = all passed, 1 = test failures, 2 = missing prerequisite (nothing silently skipped).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND = path.join(ROOT, 'frontend');
const REPORTS = path.join(ROOT, 'test-reports');
const IS_WIN = process.platform === 'win32';

const args = process.argv.slice(2);
const coverage = args.includes('--coverage');
const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';
const ALL = ['unit', 'integration', 'e2e', 'frontend'];
const selected = onlyArg ? onlyArg.split(',').map((s) => s.trim()) : ALL;
for (const s of selected) {
  if (!ALL.includes(s)) {
    console.error(`Unknown suite "${s}". Use one of: ${ALL.join(', ')}`);
    process.exit(2);
  }
}

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c('32');
const red = c('31');
const yellow = c('33');
const bold = c('1');

function fail(title, lines) {
  console.error(`\n${red(bold(`PREREQUISITE MISSING: ${title}`))}`);
  for (const l of lines) console.error(`  ${l}`);
  console.error('');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------------------------
function checkPrerequisites() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) fail(`Node.js ${process.versions.node}`, ['Node.js 18 or newer is required (20 LTS recommended).']);

  const backendNeeded = selected.some((s) => s !== 'frontend');
  if (backendNeeded && !fs.existsSync(path.join(BACKEND, 'node_modules', 'jest'))) {
    fail('backend dependencies are not installed', ['Run: npm run install:all   (or: cd backend && npm install)']);
  }
  if (selected.includes('frontend') && !fs.existsSync(path.join(FRONTEND, 'node_modules', 'vitest'))) {
    fail('frontend dependencies are not installed', ['Run: npm run install:all   (or: cd frontend && npm install)']);
  }

  if (selected.includes('integration') || selected.includes('e2e')) {
    process.stdout.write('Checking MongoDB for integration/e2e tests... ');
    const probe = spawnSync(process.execPath, [path.join(__dirname, 'check-mongo.js')], { cwd: BACKEND, encoding: 'utf8', env: process.env, timeout: 300000 });
    if (probe.status !== 0) {
      console.log(red('unavailable'));
      fail('MongoDB is not available for integration/e2e tests', [
        (probe.stdout || probe.stderr || 'unknown error').trim(),
        'Fix one of:',
        ' - allow the one-time download of the mongod binary used by mongodb-memory-server (internet access), or',
        ' - start MongoDB (docker compose up -d mongo  /  npm run mongo:local) and set',
        '   MONGODB_TEST_URI=mongodb://127.0.0.1:27017',
        'Integration and end-to-end tests are critical and are never skipped silently.',
      ]);
    }
    console.log(green(probe.stdout.trim()));
  }
}

// ---------------------------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------------------------
function runJest(project) {
  const out = path.join(REPORTS, `backend-${project}.json`);
  const jestBin = path.join(BACKEND, 'node_modules', 'jest', 'bin', 'jest.js');
  const jestArgs = [jestBin, '--selectProjects', project, '--json', `--outputFile=${out}`];
  if (project !== 'unit') jestArgs.push('--maxWorkers=50%');
  if (coverage) jestArgs.push('--coverage', `--coverageDirectory=${path.join(REPORTS, 'coverage', `backend-${project}`)}`);
  const started = Date.now();
  const res = spawnSync(process.execPath, jestArgs, { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, FORCE_COLOR: '1' } });
  return summarizeJest(`backend ${project}`, out, res.status, Date.now() - started);
}

function runVitest() {
  const out = path.join(REPORTS, 'frontend.json');
  const vitestBin = path.join(FRONTEND, 'node_modules', 'vitest', 'vitest.mjs');
  const vArgs = [vitestBin, 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`];
  if (coverage) vArgs.push('--coverage', `--coverage.reportsDirectory=${path.join(REPORTS, 'coverage', 'frontend')}`);
  const started = Date.now();
  const res = spawnSync(process.execPath, vArgs, { cwd: FRONTEND, stdio: 'inherit', env: { ...process.env, FORCE_COLOR: '1' } });
  return summarizeJest('frontend', out, res.status, Date.now() - started);
}

/** Jest and Vitest JSON reports share the same top-level shape. */
function summarizeJest(name, file, exitCode, ms) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { name, passed: 0, failed: 1, skipped: 0, total: 0, ms, failures: [`${name}: test runner crashed (exit code ${exitCode}); see output above`] };
  }
  const failures = [];
  let brokenSuites = 0;
  for (const suite of report.testResults || []) {
    const file = path.relative(ROOT, suite.name);
    const failedTests = (suite.assertionResults || []).filter((t) => t.status === 'failed');
    for (const t of failedTests) failures.push(`${file} › ${t.fullName || t.title}`);
    if (suite.status === 'failed' && failedTests.length === 0) {
      brokenSuites += 1; // e.g. a beforeAll hook or import failed: count it, never hide it
      failures.push(`${file} › suite failed to run: ${(suite.message || '').split('\n').find((l) => l.trim()) || 'unknown error'}`);
    }
  }
  if (exitCode !== 0 && failures.length === 0) failures.push(`${name}: runner exited with code ${exitCode}; see output above`);
  return {
    name,
    passed: report.numPassedTests || 0,
    // A non-zero exit with no recorded failures (e.g. a crash after tests ran) still counts as a failure.
    failed: (report.numFailedTests || 0) + brokenSuites || (exitCode !== 0 ? 1 : 0),
    skipped: (report.numPendingTests || 0) + (report.numTodoTests || 0),
    total: report.numTotalTests || 0,
    ms,
    failures,
  };
}

// ---------------------------------------------------------------------------------------------
fs.mkdirSync(REPORTS, { recursive: true });
console.log(bold(`\nMongoDB Practice Platform — automated tests (${selected.join(', ')})${coverage ? ' with coverage' : ''}\n`));
checkPrerequisites();

const results = [];
for (const suite of selected) {
  console.log(bold(`\n━━━ ${suite.toUpperCase()} ━━━`));
  results.push(suite === 'frontend' ? runVitest() : runJest(suite));
}

const row = (cells) => cells.map(([v, w, left]) => (left ? String(v).padEnd(w) : String(v).padStart(w))).join('');
console.log(bold('\n══════════════════════════ TEST SUMMARY ══════════════════════════'));
console.log(row([['Suite', 24, true], ['Passed', 8], ['Failed', 8], ['Skipped', 9], ['Total', 8], ['Time', 9]]));
const totals = { passed: 0, failed: 0, skipped: 0, total: 0 };
for (const r of results) {
  for (const k of Object.keys(totals)) totals[k] += r[k];
  const line = row([[`${r.failed ? '✗' : '✓'} ${r.name}`, 24, true], [r.passed, 8], [r.failed, 8], [r.skipped, 9], [r.total, 8], [`${(r.ms / 1000).toFixed(1)}s`, 9]]);
  console.log(r.failed ? red(line) : green(line));
}
console.log('─'.repeat(66));
console.log(bold(row([['  TOTAL', 24, true], [totals.passed, 8], [totals.failed, 8], [totals.skipped, 9], [totals.total, 8]])));

const failures = results.flatMap((r) => r.failures);
if (failures.length) {
  console.log(red(bold('\nFailed tests:')));
  for (const f of failures) console.log(red(`  ✗ ${f}`));
}
if (totals.skipped) console.log(yellow(`\nSkipped tests are optional suites (e.g. real Atlas tests need ATLAS_TEST_URI and ATLAS_TEST_DB).`));
if (coverage) console.log(`\nCoverage reports: ${path.relative(process.cwd(), path.join(REPORTS, 'coverage'))}/`);
console.log(`JSON reports:     ${path.relative(process.cwd(), REPORTS)}/\n`);

const ok = totals.failed === 0;
console.log(ok ? green(bold('RESULT: ALL TESTS PASSED')) : red(bold('RESULT: TESTS FAILED')));
process.exit(ok ? 0 : 1);
