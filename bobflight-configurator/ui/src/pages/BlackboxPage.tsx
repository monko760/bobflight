/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useHost } from '../hooks/useHost';
import { Recorder, QUERIES, csv, type Query } from '../blackbox/recorder';
import { SdCardController, type SdCommand } from '../blackbox/sd-card';
import {
  OnboardController,
  ONBOARD_API1_TARGET_LABEL,
  describeOnboardApi1Target,
  describeOnboardRate,
  formatOnboardDropPct,
  formatOnboardHz,
  formatOnboardRateReason,
  onboardAutoLowered,
  onboardEffectiveHz,
  type OnboardCommand,
} from '../blackbox/onboard';
import { SdDownloadController, downloadBlockedReason, formatRate, storageBlock } from '../blackbox/sdDownload';
import { saveBlobFile } from '../blackbox/saveBlob';
import { BLACKBOX_COUNTER_KEYS, STATUS_COUNTER_KEYS, verbatimCounters } from '../blackbox/fcCounters';

export function BlackboxPage({ visible }: { visible: boolean }) {
  const { host, connectionStatus, postFlashGate, status, refreshStatus } = useHost();
  const recorder = useMemo(() => new Recorder(host), [host]);
  const sd = useMemo(() => new SdCardController(host), [host]);
  const onboard = useMemo(() => new OnboardController(host), [host]);

  const [, render] = useState(0);
  const [queries, setQueries] = useState<Query[]>([...QUERIES]);
  const [replace, setReplace] = useState(false);
  const [backupAck, setBackupAck] = useState(false);

  const update = () => render((n) => n + 1);
  // Onboard SD log download (BB2a): fresh probe, one CRC-checked sector at a time, sd cancel.
  const sdLogs = useMemo(
    () => new SdDownloadController(host, { save: saveBlobFile, onChange: () => render((n) => n + 1) }),
    [host]
  );

  // Host-wide settings storage actions (save, defaults, StoragePanel refresh) lock Download.
  useEffect(() => host.onStorageActivity?.(update), [host]);
  const settingsStoragePending = host.storageActionPending?.() ?? false;

  // USB Bench Recorder effect
  useEffect(() => {
    if (!visible || postFlashGate || connectionStatus !== 'connected') {
      recorder.stop(!visible ? 'left-tab' : 'disconnected');
      update();
    }
    if (!visible) return;
    const timer = setInterval(() => {
      void recorder.tick().then(update);
    }, 200);
    return () => {
      clearInterval(timer);
    };
  }, [recorder, visible, connectionStatus, postFlashGate]);

  // Onboard Blackbox Controller effect (plus a 2 s `status` refresh for arm state and loop_overruns).
  // One poll at a time, and none while an SD download holds the shared command gate.
  const onboardEnabled = visible && connectionStatus === 'connected' && !postFlashGate;
  const pollBusy = useRef(false);
  const nextStatusPoll = useRef(0);
  useEffect(() => {
    onboard.setEnabled(onboardEnabled);
    update();
    if (!onboardEnabled) return;
    const timer = setInterval(() => {
      if (pollBusy.current || sdLogs.busy) return;
      pollBusy.current = true;
      void (async () => {
        try {
          await onboard.tick();
          if (!sdLogs.busy && performance.now() >= nextStatusPoll.current) {
            nextStatusPoll.current = performance.now() + 2000;
            await refreshStatus().catch(() => undefined);
          }
        } finally {
          pollBusy.current = false;
          update();
        }
      })();
    }, 500);
    return () => {
      clearInterval(timer);
      onboard.setEnabled(false);
    };
  }, [onboard, onboardEnabled, sdLogs, refreshStatus]);

  // Abort a running SD download on disconnect, tab leave or post-flash lock (sd cancel is sent while connected).
  useEffect(() => {
    if (!sdLogs.busy) return;
    if (connectionStatus !== 'connected') sdLogs.cancel('disconnected');
    else if (!visible) sdLogs.cancel('left-tab');
    else if (postFlashGate) sdLogs.cancel('blocked');
  }, [sdLogs, visible, connectionStatus, postFlashGate]);
  useEffect(() => () => sdLogs.cancel('left-tab'), [sdLogs]);

  // SD Diagnostic Controller effect
  const sdEnabled =
    visible &&
    connectionStatus === 'connected' &&
    !postFlashGate &&
    !recorder.active &&
    !onboard.active;

  useEffect(() => {
    sd.setEnabled(sdEnabled);
    update();
    if (!sdEnabled) return;
    const timer = setInterval(() => {
      if (!sdLogs.busy) void sd.tick().then(update);
    }, 1000);
    return () => {
      clearInterval(timer);
      sd.setEnabled(false);
    };
  }, [sd, sdEnabled, sdLogs]);

  function onboardCommand(command: OnboardCommand) {
    const request = onboard.command(command);
    update();
    void request.then(update);
  }

  function sdCommand(command: SdCommand) {
    const request = sd.command(command);
    update();
    void request.then(update);
  }

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (recorder.log.samples.length) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [recorder]);

  useEffect(() => () => recorder.stop('page-closed'), [recorder]);

  function download(kind: 'json' | 'csv') {
    const data =
      kind === 'json' ? JSON.stringify(recorder.log, null, 2) : csv(recorder.log);
    const url = URL.createObjectURL(
      new Blob([data], {
        type: kind === 'json' ? 'application/json' : 'text/csv',
      })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `bobflight-bench-${recorder.log.started.replace(/[:.]/g, '-')}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const isArmed = status?.arm === 'armed';
  const startDisabled =
    !onboardEnabled ||
    onboard.pending ||
    onboard.active ||
    !backupAck ||
    isArmed ||
    postFlashGate ||
    sd.busy ||
    sdLogs.busy ||
    recorder.active;
  const downloadBlocked = downloadBlockedReason({
    connected: connectionStatus === 'connected',
    postFlashGate,
    supported: sdLogs.supported,
    recording: onboard.active,
    armed: isArmed,
    // Storage lock: a settings storage action in flight, the SD diagnostic probe, or the USB bench recorder.
    storageBlocked: storageBlock({ settingsPending: settingsStoragePending, sdCheckBusy: sd.busy, benchRecording: recorder.active }),
  });
  const strictCardShown = !!onboard.snapshot && !onboard.stale && !onboard.snapshot.unavailable;
  // Fill gaps only: recorder counters already in the card above are not repeated; loop_overruns always.
  const counterRows = [
    ...(strictCardShown ? [] : verbatimCounters(onboard.lastRaw, BLACKBOX_COUNTER_KEYS)),
    ...verbatimCounters(status?.raw, STATUS_COUNTER_KEYS),
  ];
  const downloadPhaseText =
    sdLogs.phase === 'probing'
      ? 'Probing the SD card (fresh sd probe, then sd status until done)…'
      : sdLogs.phase === 'scanning'
      ? 'Reading the FAT32 root directory…'
      : sdLogs.phase === 'downloading'
      ? `Downloading ${sdLogs.progress?.file ?? ''}…`
      : sdLogs.phase === 'cancelling'
      ? 'Cancelling: waiting for the current reply, then sending sd cancel…'
      : 'No SD download in progress.';

  return (
    <section hidden={!visible} className="panel">
      <h2>Blackbox</h2>

      <div className="banner-warn" style={{ marginBottom: '1rem' }}>
        <strong>Experimental Onboard Writer:</strong> The onboard log writer is
        experimental pending physical timing validation. No flight-ready claim is
        made. Perform initial tests with propellers removed.
      </div>

      <div className="banner-warn" style={{ marginBottom: '1rem' }}>
        <strong>Power & SD Card Safety:</strong> Wait until recording state is{' '}
        <code>done</code> before removing power or removing the SD card. Do not
        disconnect power during <code>draining</code> or <code>closing</code> to
        avoid filesystem corruption.
      </div>

      <section aria-labelledby="onboard-blackbox-title">
        <h3 id="onboard-blackbox-title">Onboard SD blackbox recording</h3>
        <p>
          Record high-speed flight logs directly to a FAT32-formatted SD card
          installed on the flight controller. Each recording writes a new unique{' '}
          <code>.bbl</code> file to the card root directory (e.g.{' '}
          <code>BFL00001.BBL</code>).
        </p>

        <label style={{ display: 'block', marginBottom: '0.5rem' }}>
          <input
            type="checkbox"
            checked={backupAck}
            onChange={(e) => setBackupAck(e.target.checked)}
          />{' '}
          I acknowledge that starting recording writes a new .bbl file to the
          FAT32 card root, and backing up existing logs is my responsibility.
        </label>

        {isArmed && (
          <p className="banner-warn">
            Disarm the aircraft before starting onboard recording. Firmware disarm checks apply; UI is not the authority on arming.
          </p>
        )}
        {postFlashGate && (
          <p>
            Complete post-flash connection checks before starting onboard recording.
          </p>
        )}
        {sd.busy && (
          <p>SD card diagnostic probe is in progress. Wait for it to finish.</p>
        )}
        {recorder.active && (
          <p>
            Stop the USB bench recording before starting onboard recording.
          </p>
        )}

        <p>
          <button
            disabled={startDisabled}
            onClick={() => onboardCommand('blackbox start')}
          >
            Start onboard recording
          </button>{' '}
          <button
            disabled={!onboardEnabled || onboard.pending || !onboard.active}
            onClick={() => onboardCommand('blackbox stop')}
          >
            Stop recording
          </button>{' '}
          <button
            disabled={!onboardEnabled || onboard.pending}
            onClick={() => onboardCommand('blackbox status')}
          >
            Refresh status
          </button>
        </p>

        <p role="status" aria-live="polite">
          {connectionStatus !== 'connected'
            ? 'Connect to the controller to manage onboard recording.'
            : onboard.pending
            ? 'Communicating with controller…'
            : onboard.snapshot && onboard.stale
            ? `Status stale: the latest reply could not be read. Last known state: ${onboard.snapshot.state}${
                onboard.snapshot.active ? ' (session active; recording controls stay locked)' : ''
              }`
            : onboard.snapshot
            ? `State: ${onboard.snapshot.state}${
                onboard.snapshot.active ? ' (session active)' : ''
              }${
                onboard.snapshot.file ? ` · File: ${onboard.snapshot.file}` : ''
              }`
            : 'No onboard recording status received yet on this connection.'}
        </p>

        {!!onboard.error && <p role="alert">{onboard.error}</p>}

        {onboard.snapshot && !onboard.stale && !onboard.snapshot.unavailable && (
          <>
            <dl>
              <dt>Recording state</dt>
              <dd>
                <code>{onboard.snapshot.state}</code>
              </dd>
              <dt>Log file name</dt>
              <dd>{onboard.snapshot.file || 'Not assigned'}</dd>
              <dt>Bytes written</dt>
              <dd>{onboard.snapshot.bytes.toLocaleString()} bytes</dd>
              <dt>Frames encoded</dt>
              <dd>
                {onboard.snapshot.frames.toLocaleString()} frames (encoded;
                committed when state is done)
              </dd>
              <dt>Effective logging rate</dt>
              <dd>{describeOnboardRate(onboard.snapshot)}</dd>
              {describeOnboardApi1Target(onboard.snapshot) !== null && (
                <>
                  <dt>{ONBOARD_API1_TARGET_LABEL}</dt>
                  <dd>{describeOnboardApi1Target(onboard.snapshot)}</dd>
                </>
              )}
              <dt>Requested logging rate</dt>
              <dd>{formatOnboardHz(onboard.snapshot.requestedHz)}</dd>
              <dt>Rate reason</dt>
              <dd>{formatOnboardRateReason(onboard.snapshot.rateReason)}</dd>
              <dt>Dropped frames</dt>
              <dd>{onboard.snapshot.dropped.toLocaleString()}</dd>
              <dt>Dropped percent (reported by FC)</dt>
              <dd>{formatOnboardDropPct(onboard.snapshot.dropPct)}</dd>
              <dt>Status detail / reason</dt>
              <dd>{onboard.snapshot.reason || 'None reported'}</dd>
            </dl>

            <fieldset style={{ margin: '1rem 0' }}>
              <legend>
                <strong>Data loss counters</strong>
              </legend>
              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: '0.5rem',
                  textAlign: 'center',
                }}
              >
                <div>
                  <dt>Dropped frames</dt>
                  <dd style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>
                    {onboard.snapshot.dropped.toLocaleString('en-US')} ({formatOnboardDropPct(onboard.snapshot.dropPct)})
                  </dd>
                </div>
                <div>
                  <dt>Missed frames</dt>
                  <dd style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>
                    {onboard.snapshot.missed}
                  </dd>
                </div>
                <div>
                  <dt>Invalid frames</dt>
                  <dd style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>
                    {onboard.snapshot.invalid}
                  </dd>
                </div>
                <div>
                  <dt>Queue overflow / depth</dt>
                  <dd style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>
                    {onboard.snapshot.queue}
                  </dd>
                </div>
              </dl>
            </fieldset>

            {onboardAutoLowered(onboard.snapshot) && (
              <p role="status">
                The SD card could not keep up at {formatOnboardHz(onboard.snapshot.requestedHz)}, so the
                controller lowered logging to {formatOnboardHz(onboardEffectiveHz(onboard.snapshot))} for this session
                (auto-lowered-card-slow). The file header states the effective rate;
                frames lost before the change remain counted above. Consider a faster card.
              </p>
            )}
            {onboard.snapshot.dropped > 0 && <p role="alert">Samples were lost during recording. An empty final queue does not undo those losses. Preserve the file and final status for diagnosis; do not treat this as a complete tuning log.</p>}
            <p className="muted">
              <strong>Log retrieval:</strong> use <em>Download logs from the onboard SD card</em> below.
            </p>

            <p className="muted">
              <strong>Motor commands & Blackbox Explorer:</strong> Onboard logs
              record requested mixer motor commands (not motor RPM). When
              analyzing logs in Blackbox Explorer, plot direct setpoint and{' '}
              <code>bobflightError</code> rather than legacy computed fields.
            </p>
          </>
        )}

        {onboard.snapshot?.unavailable && (
          <p>
            Onboard blackbox recording is unavailable on this connection (the default
            demo port has no SD card). To try it without hardware, connect one of the
            SD card demo ports marked “— SIMULATED”; they never write to a physical card.
          </p>
        )}

        {onboard.snapshot && !onboard.stale && (
          <details>
            <summary>Onboard blackbox reply</summary>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{onboard.snapshot.raw}</pre>
          </details>
        )}

        {connectionStatus === 'connected' && (
          <div aria-labelledby="bb-fc-counters-title">
            <h4 id="bb-fc-counters-title">Counters as reported by the FC</h4>
            <p className="muted">
              Exactly as sent (no math); “unknown” means the FC did not report it.
              {strictCardShown ? ' Recorder counters are shown in the card above; loop_overruns comes from status.' : ''}
            </p>
            <dl data-testid="bb-fc-counters">
              {counterRows.map((row) => (
                <div key={row.key} data-key={row.key}>
                  <dt>
                    <code>{row.key}</code>
                  </dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </section>

      <hr />

      <section aria-labelledby="bb-download-title" data-testid="bb-download">
        <h3 id="bb-download-title">Download logs from the onboard SD card</h3>
        <p>
          Reads <code>BFLxxxxx.BBL</code> logs from the FAT32 card root over USB, one 512-byte
          sector at a time, checking each sector&apos;s CRC-32. Read-only: nothing is written to
          the card. Every list and download starts with a fresh SD probe and ends with{' '}
          <code>sd cancel</code>. A file is saved only after every sector verified and its size
          matches the directory entry. Disarm first; recording must be stopped and done (the
          recorder state is re-read with <code>blackbox status</code> before any sector is read).
        </p>
        <p>
          <button disabled={!!downloadBlocked || sdLogs.busy} onClick={() => void sdLogs.list()}>
            Probe card and list logs
          </button>{' '}
          <button
            disabled={!sdLogs.busy || sdLogs.phase === 'cancelling'}
            onClick={() => sdLogs.cancel('user')}
          >
            Cancel download
          </button>
        </p>
        {downloadBlocked && <p data-testid="bb-download-blocked">{downloadBlocked}</p>}
        <p role="status" aria-live="polite" data-testid="bb-download-phase">
          {downloadPhaseText}
        </p>
        {sdLogs.progress && (
          <div data-testid="bb-download-progress">
            <progress max={sdLogs.progress.bytesTotal} value={sdLogs.progress.bytesDone} />
            <p>
              {sdLogs.progress.bytesDone.toLocaleString('en-US')} of{' '}
              {sdLogs.progress.bytesTotal.toLocaleString('en-US')} bytes ·{' '}
              {sdLogs.progress.sectorsDone} of {sdLogs.progress.sectorsTotal} sectors ·{' '}
              {formatRate(sdLogs.progress.bytesPerSecond)}
            </p>
          </div>
        )}
        {sdLogs.message && (
          <div
            role={sdLogs.message.tone === 'error' ? 'alert' : 'status'}
            data-testid="bb-download-result"
            data-tone={sdLogs.message.tone}
          >
            {sdLogs.message.fwLine !== null && (
              <p>
                Controller reply: <code data-testid="bb-download-fw-line">{sdLogs.message.fwLine}</code>
              </p>
            )}
            <p data-testid="bb-download-message">{sdLogs.message.text}</p>
          </div>
        )}
        {sdLogs.recorderNote && (
          <p role="status" data-testid="bb-download-recorder-note">
            {sdLogs.recorderNote}
          </p>
        )}
        {sdLogs.files && sdLogs.files.length > 0 && (
          <table data-testid="bb-download-files">
            <thead>
              <tr>
                <th>File</th>
                <th>Size (bytes)</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {sdLogs.files.map((f) => (
                <tr key={f.name} data-file={f.name}>
                  <td>
                    <code>{f.name}</code>
                  </td>
                  <td>{f.size.toLocaleString('en-US')}</td>
                  <td>
                    <button
                      disabled={!!downloadBlocked || sdLogs.busy || f.size === 0}
                      onClick={() => void sdLogs.download(f.name)}
                    >
                      Download {f.name}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          <strong>Fallback:</strong> disconnect the configurator and run{' '}
          <code>tools/download_blackbox.py</code> on your PC to copy a named log over USB (see{' '}
          <code>USB-LOG-EXPORT.md</code>), or, after state is <code>done</code>, power off and use
          an SD card reader (also the way to read a card that is not FAT32). USB mass-storage mode
          is not offered.
        </p>
      </section>

      <hr />

      <section aria-labelledby="sd-card-title">
        <h3 id="sd-card-title">Onboard SD card</h3>
        <p>
          Check the card installed in the flight controller. This is a read-only
          diagnostic: it does not format, mount, repair or write to the card.
          Remove propellers, disarm, and stop motor tests and calibration first.
        </p>
        <p>
          <button
            disabled={!sdEnabled || sd.busy || onboard.active || sdLogs.busy}
            onClick={() => sdCommand('sd probe')}
          >
            Check SD card
          </button>{' '}
          <button
            disabled={!sdEnabled || sd.pending || sdLogs.busy}
            onClick={() => sdCommand('sd status')}
          >
            Refresh status
          </button>{' '}
          <button
            disabled={!sdEnabled || sd.pending || sdLogs.busy}
            onClick={() => sdCommand('sd cancel')}
          >
            Cancel probe
          </button>
        </p>
        {onboard.active && (
          <p>Stop onboard blackbox recording before checking the SD card.</p>
        )}
        {recorder.active && (
          <p>Stop the USB bench recording before checking the SD card.</p>
        )}
        {postFlashGate && (
          <p>
            Complete the post-flash connection checks before using SD
            diagnostics.
          </p>
        )}
        <p role="status" aria-live="polite">
          {connectionStatus !== 'connected'
            ? 'Connect to the controller to check its SD card.'
            : sd.pending
            ? 'Reading controller reply…'
            : sd.polling
            ? 'Checking card; refreshing status once per second…'
            : sd.snapshot
            ? `Last probe state: ${sd.snapshot.state}`
            : 'No card check requested on this connection.'}
        </p>
        {!!sd.error && <p role="alert">{sd.error}</p>}
        {sd.snapshot && !sd.snapshot.unavailable && (
          <dl>
            <dt>Reported capacity</dt>
            <dd>
              {sd.snapshot.capacityBytes
                ? `${(sd.snapshot.capacityBytes / 1e9).toFixed(2)} GB (${sd.snapshot.capacityBytes.toLocaleString()} bytes)`
                : 'Not established'}
            </dd>
            <dt>Filesystem hint</dt>
            <dd>{sd.snapshot.filesystem} (not mounted or fully validated)</dd>
            <dt>Partition start</dt>
            <dd>
              {sd.snapshot.partitionLba === null
                ? 'Not reported'
                : `${sd.snapshot.partitionLba} sectors`}
            </dd>
            <dt>Cluster size</dt>
            <dd>
              {sd.snapshot.clusterBytes
                ? `${sd.snapshot.clusterBytes.toLocaleString()} bytes`
                : 'Not established'}
            </dd>
            <dt>Diagnostic detail</dt>
            <dd>{sd.snapshot.detail || 'Not reported'}</dd>
            <dt>Card I/O error code</dt>
            <dd>{sd.snapshot.ioError ?? 'Not reported'}</dd>
          </dl>
        )}
        {sd.snapshot?.unavailable && (
          <p>
            SD diagnostics are unavailable on this connection. Demo ports do not
            simulate SD diagnostics (the “— SIMULATED” SD card demo ports cover onboard
            recording only); older firmware may not support the commands.
          </p>
        )}
        {sd.snapshot && (
          <details>
            <summary>SD diagnostic reply</summary>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{sd.snapshot.raw}</pre>
          </details>
        )}
      </section>

      <hr />

      <h3>USB bench recorder (JSON / CSV)</h3>
      <p>
        Record sensor, receiver, power and status replies on this computer.
        Remove propellers for bench work. Recording only reads data; it does not
        start motors or PID diagnostics.
      </p>
      <p>
        Up to five requests per second, shared between the selected sources. Each
        reply has its own timestamp; this is not a high-speed flight log or
        Blackbox Explorer file. PID values are available only during a separately
        started diagnostic session; inactive and unsupported replies are retained as
        reported.
      </p>
      <fieldset disabled={recorder.active || onboard.active}>
        <legend>Data sources</legend>
        {QUERIES.map((q) => (
          <label key={q} style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={queries.includes(q)}
              onChange={(e) =>
                setQueries(
                  e.target.checked
                    ? [...queries, q]
                    : queries.filter((x) => x !== q)
                )
              }
            />
            {q}
          </label>
        ))}
      </fieldset>
      {!!recorder.log.samples.length && !recorder.active && (
        <label style={{ display: 'block' }}>
          <input
            type="checkbox"
            checked={replace}
            onChange={(e) => setReplace(e.target.checked)}
          />
          Replace this recording when starting a new one (download it first).
        </label>
      )}
      {onboard.active && (
        <p>Stop onboard recording before starting a USB bench recording.</p>
      )}
      <p>
        <button
          disabled={
            sd.busy ||
            sdLogs.busy ||
            onboard.active ||
            recorder.active ||
            connectionStatus !== 'connected' ||
            postFlashGate ||
            !queries.length ||
            (!!recorder.log.samples.length && !replace)
          }
          onClick={() => {
            recorder.start(queries);
            setReplace(false);
            update();
          }}
        >
          Start recording
        </button>{' '}
        <button
          disabled={!recorder.active}
          onClick={() => {
            recorder.stop();
            update();
          }}
        >
          Stop recording
        </button>{' '}
        <button
          disabled={recorder.active || !recorder.log.samples.length}
          onClick={() => download('json')}
        >
          Download JSON
        </button>{' '}
        <button
          disabled={recorder.active || !recorder.log.samples.length}
          onClick={() => download('csv')}
        >
          Download CSV
        </button>
      </p>
      <p role="status">
        {recorder.active ? 'Recording' : recorder.log.reason} ·{' '}
        {recorder.log.samples.length} replies captured
      </p>
      <p>
        Recording stops when you leave this tab, lose the connection, or reach ten
        minutes / the memory limit. Captured data stays here across tab changes;
        download it before refreshing or closing the page. Demo connections
        contain simulated data.
      </p>
      <details>
        <summary>Latest reply</summary>
        <pre style={{ whiteSpace: 'pre-wrap' }}>
          {recorder.log.samples.at(-1)?.raw ||
            recorder.log.samples.at(-1)?.error ||
            'No samples yet.'}
        </pre>
      </details>
    </section>
  );
}
