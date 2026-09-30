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

const { OnboardController, parseOnboardReply, describeOnboardRate, describeOnboardDrops, formatOnboardHz, formatOnboardDropPct, formatOnboardRateReason, onboardAutoLowered } = mod.exports;

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
    makeReply('recording').replace('blackbox_api: 1', 'blackbox_api: 3'),
    makeReply('recording').replace('blackbox_rate_hz: 500', 'blackbox_rate_hz: 250'), // api 1 FCs only log at 500
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

  // 5b. api 1 FC: only the old fields. Requested rate, reason and drop % are
  // "unknown" -- never defaulted to 500/0 and never computed by the UI.
  assert.equal(parsed.requestedHz, null);
  assert.equal(parsed.rateReason, null);
  assert.equal(parsed.dropPct, null);
  const lossy1 = parseOnboardReply(makeReply('done', 0).replace('blackbox_frames: 2000', 'blackbox_frames: 650').replace('blackbox_dropped: 1', 'blackbox_dropped: 3731'));
  assert.equal(lossy1.dropped, 3731); // Robert's physical log (api 1): count shown as sent
  assert.equal(lossy1.dropPct, null); // NOT 85.2 -- the UI never computes it
  assert.equal(describeOnboardDrops(lossy1), '3,731 dropped (unknown)');
  assert.equal(formatOnboardHz(lossy1.requestedHz), 'unknown');
  assert.equal(formatOnboardRateReason(lossy1.rateReason), 'unknown');
  assert.equal(formatOnboardDropPct(lossy1.dropPct), 'unknown');
  assert.equal(describeOnboardRate(lossy1), '500 Hz'); // the FC's own blackbox_rate_hz
  assert.equal(onboardAutoLowered(lossy1), false);
  // api 1 keys that happen to carry api 2 names are still ignored for api 1.
  const v1extra = parseOnboardReply(makeReply('done', 0).replace('blackbox_end: 1', 'blackbox_drop_pct: 9.9\r\nblackbox_end: 1'));
  assert.equal(v1extra.dropPct, null);
  // A missing rate key is "unknown", never 500.
  const v1norate = parseOnboardReply(makeReply('done', 0).replace('blackbox_rate_hz: 500\r\n', ''));
  assert.equal(v1norate.rateHz, null);
  assert.equal(describeOnboardRate(v1norate), 'unknown');

  // 5c. api 2 (frozen contract): effective rate, requested rate, reason, pct.
  const makeV2 = ({ state = 'recording', active = 1, frames = 5306, dropped = 92, rate = 250, requested = 500, reason = 'auto-lowered-card-slow', pct = '1.7', extra = '' } = {}) => `blackbox_api: 2\r
blackbox_state: ${state}\r
blackbox_reason: recording\r
blackbox_file: BFL00001.BBL\r
blackbox_bytes: 375176\r
blackbox_frames: ${frames}\r
blackbox_rate_hz: ${rate}\r
blackbox_dropped: ${dropped}\r
blackbox_missed: 0\r
blackbox_invalid: 0\r
blackbox_queue: 0\r
blackbox_active: ${active}\r
blackbox_rate_requested_hz: ${requested}\r
blackbox_rate_reason: ${reason}\r
blackbox_drop_pct: ${pct}\r
${extra}blackbox_end: 1\r
`;
  // api 2 auto-lowered
  const v2 = parseOnboardReply(makeV2());
  assert.equal(v2.api, 2);
  assert.equal(v2.rateHz, 250);
  assert.equal(v2.requestedHz, 500);
  assert.equal(v2.rateReason, 'auto-lowered-card-slow');
  assert.equal(v2.dropPct, '1.7');
  assert.equal(v2.dropped, 92);
  assert.equal(onboardAutoLowered(v2), true);
  assert.match(describeOnboardRate(v2), /^250 Hz \(requested 500 Hz; auto-lowered because the SD card could not keep up\)$/);
  assert.equal(describeOnboardDrops(v2), '92 dropped (1.7%)');
  // api 2 default
  const v2ok = parseOnboardReply(makeV2({ frames: 9845, dropped: 0, rate: 500, reason: 'default', pct: '0.0' }));
  assert.equal(v2ok.rateHz, 500); assert.equal(v2ok.requestedHz, 500); assert.equal(v2ok.dropPct, '0.0');
  assert.equal(describeOnboardRate(v2ok), '500 Hz'); assert.equal(onboardAutoLowered(v2ok), false);
  assert.equal(describeOnboardDrops(v2ok), '0 dropped (0.0%)');
  assert.equal(parseOnboardReply(makeV2({ rate: 125, pct: '28.4', dropped: 788, frames: 1988 })).rateHz, 125);
  // The FC's own percent string is shown verbatim, even if counters would round differently.
  assert.equal(parseOnboardReply(makeV2({ pct: '1.8' })).dropPct, '1.8');
  assert.equal(parseOnboardReply(makeV2({ pct: '10.0' })).dropPct, '10.0');
  // Future reason tokens are tolerated and shown verbatim, with no auto-lowered note.
  const future = parseOnboardReply(makeV2({ rate: 250, reason: 'auto-lowered-cpu-budget' }));
  assert.equal(future.rateReason, 'auto-lowered-cpu-budget');
  assert.equal(onboardAutoLowered(future), false);
  assert.equal(describeOnboardRate(future), '250 Hz');
  // Missing api 2 keys render as "unknown", never 0/500/computed.
  const noReq = parseOnboardReply(makeV2().replace('blackbox_rate_requested_hz: 500\r\n', ''));
  assert.equal(noReq.requestedHz, null);
  assert.match(describeOnboardRate(noReq), /requested unknown; auto-lowered/);
  const noReason = parseOnboardReply(makeV2().replace('blackbox_rate_reason: auto-lowered-card-slow\r\n', ''));
  assert.equal(noReason.rateReason, null); assert.equal(onboardAutoLowered(noReason), false);
  assert.equal(describeOnboardRate(noReason), '250 Hz');
  const noPct = parseOnboardReply(makeV2().replace('blackbox_drop_pct: 1.7\r\n', ''));
  assert.equal(noPct.dropPct, null); assert.equal(describeOnboardDrops(noPct), '92 dropped (unknown)');
  const noRate = parseOnboardReply(makeV2().replace('blackbox_rate_hz: 250\r\n', ''));
  assert.equal(noRate.rateHz, null); assert.match(describeOnboardRate(noRate), /^unknown \(requested 500 Hz; auto-lowered/);
  const badV2 = [
    makeV2({ pct: '1.75' }), makeV2({ pct: '1' }), makeV2({ pct: 'NaN' }), makeV2({ pct: '100.1' }),
    makeV2({ rate: 1000 }),                        // effective above requested
    makeV2({ rate: 300 }),                         // unsupported rate
    makeV2({ requested: 300 }),                    // unsupported requested rate
    makeV2({ rate: 500, reason: 'auto-lowered-card-slow' }), // lowered but not lower
    makeV2({ rate: 250, reason: 'default' }),      // lower rate without a reason
    makeV2({ reason: 'Bad Reason' }),
    makeV2({ extra: 'blackbox_drop_pct: 1.7\r\n' }), // duplicate key
  ];
  for (const bad of badV2) assert.throws(() => parseOnboardReply(bad));
  // Unknown extra api 2 keys remain safe.
  assert.equal(parseOnboardReply(makeV2({ extra: 'blackbox_future_field: 7\r\n' })).rateHz, 250);
  // Unavailable replies carry no invented rate either.
  assert.equal(parseOnboardReply('blackbox unavailable: mock has no physical SD card\r\nblackbox_end: 1\r\n').rateHz, null);

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
    'PASS onboard panel model: status api 1 (new fields unknown) + api 2 default/auto-lowered (effective/requested rate, reason, verbatim drop %, missing keys unknown), explicit start/stop, 1Hz status polling, framing validation, unknown/repeated line safety, no autoStop on hide/disconnect, and error preservation'
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
