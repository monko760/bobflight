import { useEffect, useMemo, useState } from 'react';
import { useHost } from '../hooks/useHost';
import { Recorder, QUERIES, csv, type Query } from '../blackbox/recorder';
import { SdCardController, type SdCommand } from '../blackbox/sd-card';
import { OnboardController, type OnboardCommand } from '../blackbox/onboard';

export function BlackboxPage({ visible }: { visible: boolean }) {
  const { host, connectionStatus, postFlashGate, status } = useHost();
  const recorder = useMemo(() => new Recorder(host), [host]);
  const sd = useMemo(() => new SdCardController(host), [host]);
  const onboard = useMemo(() => new OnboardController(host), [host]);

  const [, render] = useState(0);
  const [queries, setQueries] = useState<Query[]>([...QUERIES]);
  const [replace, setReplace] = useState(false);
  const [backupAck, setBackupAck] = useState(false);

  const update = () => render((n) => n + 1);

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

  // Onboard Blackbox Controller effect
  const onboardEnabled = visible && connectionStatus === 'connected' && !postFlashGate;
  useEffect(() => {
    onboard.setEnabled(onboardEnabled);
    update();
    if (!onboardEnabled) return;
    const timer = setInterval(() => {
      void onboard.tick().then(update);
    }, 500);
    return () => {
      clearInterval(timer);
      onboard.setEnabled(false);
    };
  }, [onboard, onboardEnabled]);

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
      void sd.tick().then(update);
    }, 1000);
    return () => {
      clearInterval(timer);
      sd.setEnabled(false);
    };
  }, [sd, sdEnabled]);

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
    recorder.active;

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
            : onboard.snapshot
            ? `State: ${onboard.snapshot.state}${
                onboard.snapshot.active ? ' (session active)' : ''
              }${
                onboard.snapshot.file ? ` · File: ${onboard.snapshot.file}` : ''
              }`
            : 'No onboard recording status received yet on this connection.'}
        </p>

        {!!onboard.error && <p role="alert">{onboard.error}</p>}

        {onboard.snapshot && !onboard.snapshot.unavailable && (
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
              <dt>Target sampling rate</dt>
              <dd>{onboard.snapshot.rateHz} Hz</dd>
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
                    {onboard.snapshot.dropped}
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

            {onboard.snapshot.dropped > 0 && <p role="alert">Samples were lost during recording. An empty final queue does not undo those losses. Preserve the file and final status for diagnosis; do not treat this as a complete tuning log.</p>}
            <p>
              <button
                disabled
                title="Use the PC USB extraction utility or an SD card reader. The integrated button is not implemented yet."
              >
                Download .bbl (PC utility or SD card reader)
              </button>
            </p>
            <p className="muted">
              <strong>Log retrieval:</strong> With firmware ending in <code>-sdread1</code>,
              disconnect the configurator and use <code>tools/download_blackbox.py</code>
              on your PC to copy a named existing log over USB, including after reboot.
              See <code>USB-LOG-EXPORT.md</code>. This integrated download button and USB
              mass-storage mode are not implemented. Alternatively, after state is
              <code> done</code>, power off and use an external SD card reader.
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
            Onboard blackbox recording is unavailable on this connection. Demo mode
            does not simulate physical SD writing.
          </p>
        )}

        {onboard.snapshot && (
          <details>
            <summary>Onboard blackbox reply</summary>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{onboard.snapshot.raw}</pre>
          </details>
        )}
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
            disabled={!sdEnabled || sd.busy || onboard.active}
            onClick={() => sdCommand('sd probe')}
          >
            Check SD card
          </button>{' '}
          <button
            disabled={!sdEnabled || sd.pending}
            onClick={() => sdCommand('sd status')}
          >
            Refresh status
          </button>{' '}
          <button
            disabled={!sdEnabled || sd.pending}
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
            SD diagnostics are unavailable on this connection. Demo mode does not
            simulate a working card; older firmware may not support the commands.
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
