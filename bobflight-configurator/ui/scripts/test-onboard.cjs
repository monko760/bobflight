/* SPDX-License-Identifier: Apache-2.0 */
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  ts = require('typescript');

const mod = { exports: {} };
new Function(
  'exports',
  'require',
  'module',
  ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../src/blackbox/onboard.ts'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }
  ).outputText
)(mod.exports, require, mod);

const { OnboardController, parseOnboardReply } = mod.exports;

const makeReply = (state, active = 1, file = 'BFL00001.BBL') => `blackbox_api: 1\r
blackbox_state: ${state}\r
blackbox_reason: test run\r
blackbox_file: ${file}\r
blackbox_bytes: 1048576\r
blackbox_frames: 2000\r
blackbox_rate_hz: 500\r
blackbox_dropped: 1\r
blackbox_missed: 2\r
blackbox_invalid: 0\r
blackbox_queue: 3\r
blackbox_active: ${active}\r
blackbox_end: 1\r
`;

(async () => {
  // 1. Test reply parsing - normal recording reply
  const parsed = parseOnboardReply(makeReply('recording', 1));
  assert.equal(parsed.api, 1);
  assert.equal(parsed.state, 'recording');
  assert.equal(parsed.file, 'BFL00001.BBL');
  assert.equal(parsed.bytes, 1048576);
  assert.equal(parsed.frames, 2000);
  assert.equal(parsed.rateHz, 500);
  assert.equal(parsed.dropped, 1);
  assert.equal(parsed.missed, 2);
  assert.equal(parsed.invalid, 0);
  assert.equal(parsed.queue, 3);
  assert.equal(parsed.active, true);
  assert.equal(parsed.unavailable, false);

  // 2. Test reply parsing - unavailable replies
  assert(parseOnboardReply('unknown - try help\r\n').unavailable);
  assert(
    parseOnboardReply(
      'blackbox unavailable: mock has no physical SD card\r\nblackbox_end: 1\r\n'
    ).unavailable
  );
  assert(
    parseOnboardReply('blackbox_state: unavailable-mock\r\nblackbox_end: 1\r\n')
      .unavailable
  );

  // 3. Test reply parsing - refusal
  assert.throws(() =>
    parseOnboardReply('blackbox refused: physical card write error\r\n')
  );

  // 4. Test reply parsing - malformed / missing framing / bad field values
  const malformed = [
    makeReply('recording').replace('blackbox_end: 1', ''),
    makeReply('recording').replace('blackbox_api: 1', 'blackbox_api: 2'),
    makeReply('recording').replace('blackbox_state: recording', 'blackbox_state: invalid_state'),
    makeReply('recording').replace('1048576', 'NaN'),
    makeReply('recording').replace('1048576', '-100'),
    makeReply('recording').replace('blackbox_active: 1', 'blackbox_active: 5'),
    makeReply('recording').replace('blackbox_dropped: 1\r\n', ''),
  ];
  for (const bad of malformed) {
    assert.throws(() => parseOnboardReply(bad));
  }

  // 5. Test reply parsing - unknown and repeated fields are safe
  const extraUnknown = makeReply('recording').replace('blackbox_end: 1','blackbox_future_field: 42\r\nblackbox_end: 1');
  const parsedExtra = parseOnboardReply(extraUnknown);
  assert.equal(parsedExtra.state, 'recording');

  const repeatedKey = makeReply('recording') + 'blackbox_rate_hz: 500\r\n';
  assert.throws(()=>parseOnboardReply(repeatedKey));
  assert.throws(()=>parseOnboardReply(makeReply('recording',0)));
  assert.throws(()=>parseOnboardReply(makeReply('recording').replace('blackbox_queue: 3','blackbox_queue: 65')));
  assert.throws(()=>parseOnboardReply(makeReply('recording').replace('blackbox_end: 1','blackbox_rate_hz: 500\r\nblackbox_end: 1')));

  // 6. Controller lifecycle tests
  let time = 0,
    connected = true,
    resolve;
  const calls = [];
  const link = {
    getConnectionStatus: () => (connected ? 'connected' : 'disconnected'),
    sendCommand: (c) => {
      calls.push(c);
      return new Promise((r) => (resolve = r));
    },
  };

  const controller = new OnboardController(link, () => time);

  // Disabled controller ignores commands and ticks
  assert.equal(await controller.command('blackbox start'), false);
  await controller.tick();
  assert.equal(calls.length, 0);

  // Enable controller
  controller.setEnabled(true);

  // First tick immediately issues 'blackbox status'
  const firstTick = controller.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'blackbox status');
  resolve(makeReply('idle', 0, ''));
  await firstTick;
  assert.equal(controller.snapshot.state, 'idle');
  assert.equal(controller.active, false);

  // User explicit start command
  const startCmd = controller.command('blackbox start');
  assert(controller.pending);
  // Pending rejects concurrent start command
  assert.equal(await controller.command('blackbox start'), false);
  resolve(makeReply('recording', 1, 'BFL00001.BBL'));
  await startCmd;
  assert.equal(controller.snapshot.state, 'recording');
  assert.equal(controller.active, true);

  // 1Hz status polling
  time += 500;
  await controller.tick();
  assert.equal(calls.length, 2); // nextPoll not reached yet

  time += 500; // now time = 1000
  const pollTick = controller.tick();
  assert.equal(calls.length, 3);
  assert.equal(calls[2], 'blackbox status');
  resolve(makeReply('recording', 1, 'BFL00001.BBL'));
  await pollTick;

  // Stale reply rejection on setEnabled toggle
  const lateCmd = controller.command('blackbox status');
  controller.setEnabled(false); // Tab hide / disconnect
  resolve(makeReply('recording', 1, 'BFL00001.BBL'));
  await lateCmd;
  assert.equal(controller.snapshot, null);

  // Verify NEVER auto-stopped on disable!
  assert(!calls.includes('blackbox stop'));

  // Re-enable controller
  controller.setEnabled(true);

  // Explicit stop command
  const stopCmd = controller.command('blackbox stop');
  resolve(makeReply('done', 0, 'BFL00001.BBL'));
  await stopCmd;
  assert.equal(controller.snapshot.state, 'done');
  assert.equal(controller.active, false);

  // Disconnect behavior
  connected = false;
  await controller.tick();
  assert.equal(await controller.command('blackbox status'), false);

  // Error handling test
  connected = true;
  const broken = new OnboardController(
    {
      getConnectionStatus: () => 'connected',
      sendCommand: async () => {
        throw new Error('connection lost');
      },
    },
    () => time
  );
  broken.setEnabled(true);
  assert.equal(await broken.command('blackbox start'), false);
  assert.match(broken.error, /connection lost/);

  console.log(
    'PASS onboard panel model: explicit start/stop, 1Hz status polling, framing validation, unknown/repeated line safety, no autoStop on hide/disconnect, and error preservation'
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
