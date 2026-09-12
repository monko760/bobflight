/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState } from "react";
import { useHost } from "../hooks/useHost";
import { BenchController, benchBlockReason, MOTOR_POSITIONS, type BenchState } from "../motors/benchController";

export function MotorsPage() {
  const { host, postFlashGate } = useHost();
  const [controller, setController] = useState<BenchController | null>(null);
  const [state, setState] = useState<BenchState | null>(null);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    // Fresh controller for each mount (also safe under React StrictMode replay).
    const c = new BenchController(host);
    setController(c);
    const offView = c.subscribe(setState);
    const offConnection = host.onStatus(status => c.connection(status === "connected"));
    c.connection(host.getConnectionStatus() === "connected");
    const visibility = () => c.setVisible(!document.hidden && !postFlashGate);
    visibility();
    const hide = () => c.setVisible(false);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", hide);
    void c.poll();
    const poll = setInterval(() => void c.poll(), 500);
    const clock = setInterval(() => setNow(performance.now()), 100);
    return () => {
      clearInterval(poll); clearInterval(clock);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", hide);
      offView();
      // Track disconnect/reconnect until the best-effort stop settles so it
      // cannot be replayed into a different USB session after unmount.
      void c.leave().finally(offConnection);
    };
  }, [host, postFlashGate]);
  if (!state || !controller) return <div className="panel">Preparing motor controls…</div>;
  const reason = benchBlockReason(state, now);
  const remaining = Math.max(0, state.estimatedUntil - now);
  const disabled = !!reason || state.busy || postFlashGate;
  const capability = state.capabilities;
  const readiness = state.status?.motor_output && / ready$/.test(state.status.motor_output) ? "Ready (driver reports)" : "Unavailable / unknown";
  const rate = state.rate ? `DShot${state.rate}` : "Unknown";
  return <section className="panel motor-bench" aria-labelledby="motor-title">
    <div className="motor-heading">
      <div><p className="motor-eyebrow">PROPS-OFF WORKBENCH</p><h2 id="motor-title">Motor tests</h2><p className="muted">Verify wiring and rotation, one motor at a time. These controls do not arm the aircraft.</p></div>
      <button className="danger motor-stop" disabled={!state.connected} onClick={() => void controller.stop()}>{state.stopping ? "Stop requested…" : "Stop all motor tests"}</button>
    </div>
    {state.status?.board?.startsWith("mock") && <div className="banner-warn"><strong>SIMULATION — no hardware is being driven.</strong> This mock is for checking controls, not validating your flight controller.</div>}
    <div className="banner-warn"><strong>Remove every propeller.</strong> Secure the frame, keep hands clear, and keep battery power easy to disconnect. USB alone does not power the ESCs. Bench commands spin motors even when flight arming is disabled.</div>
    <div className="motor-stats">
      <div><span>Controller</span><strong>{state.status?.board ?? "Not connected"}</strong></div>
      <div><span>Outputs · {state.status?.dshot_bound ?? "—"}</span><strong>{readiness}</strong></div>
      <div><span>Protocol readback</span><strong>{rate}</strong></div>
      <div><span>Arming state</span><strong>{state.status?.arm ?? "Unknown"}</strong></div>
    </div>
    <fieldset className="motor-checks"><legend>Before each test</legend>
      <label><input type="checkbox" checked={state.propsOff} disabled={!state.connected} onChange={e => controller.confirmProps(e.target.checked)} /> All props are removed and the frame is secured.</label>
      <label><input type="checkbox" checked={state.stationary} disabled={!state.connected || state.busy || remaining > 0} onChange={e => controller.confirmStationary(e.target.checked)} /> I can see that every motor is stationary.</label>
      <p className="muted">Stationary confirmation resets after each test. Confirmations reset after reconnecting or leaving this page.</p>
    </fieldset>
    <p className="motor-gate" role="status">{reason ?? (state.busy ? "Communicating with controller…" : "Ready for an explicit test request.")}</p>
    {capability && !capability.individual && <p className="banner-warn">This firmware does not advertise motor_test. Install the tested BobFlight bench firmware before using these controls.</p>}
    <div className="motor-workspace">
      <div className="motor-map" aria-label="Motor positions viewed from above; front at the top">
        <div className="motor-front">↑ FRONT · TOP VIEW</div>
        {MOTOR_POSITIONS.map(({ motor, name, position }) => <div key={motor} className={`motor-card ${position}`}>
          <span className="motor-number">M{motor}</span><strong>{name}</strong>
          <span className="muted">1 second · 8% command</span>
          <button disabled={disabled || !capability?.individual} onClick={() => void controller.start(motor)}>Test motor {motor}</button>
        </div>)}
        <div className="motor-map-caption">Expected wiring layout—not detected motor positions. Observe CW / CCW yourself; no direction reversal command is provided.</div>
      </div>
      <div className="motor-options">
        <section className="motor-option-panel"><h3>DShot bit rate</h3>
          <p>Current: <strong>{rate}</strong></p>
          <div className="row">{([300, 600] as const).map(value => <button key={value} aria-pressed={state.rate === value} disabled={disabled || !capability?.dshot || state.rate === value} onClick={() => void controller.setRate(value)}>DShot{value}</button>)}</div>
          <p className="muted">Choose only a rate your ESC supports. Changes are read back from the controller and last until reboot. Motors must be stationary before switching.</p>
          {capability && !capability.dshot && <p className="banner-warn">Rate selection is unavailable on this firmware. No rate is assumed.</p>}
        </section>
        <section className="motor-option-panel"><h3>Motor sequence</h3><p>M1 rear-right → M2 front-right → M3 rear-left → M4 front-left.</p>
          <p className="muted">One-second pulses at 8%, with 0.7-second gaps. Check each motor individually first.</p>
          <button disabled={disabled || !capability?.sequence} onClick={() => void controller.start("sequence")}>Run sequence 1 → 4</button>
          {capability && !capability.sequence && <p className="banner-warn">This firmware does not advertise motor_seq.</p>}
        </section>
      </div>
    </div>
    <div className="motor-result" aria-live="polite">
      {remaining > 0 && <p><strong>{state.testLabel}</strong> · estimated test window: {(remaining / 1000).toFixed(1)}s remaining</p>}
      {state.testLabel && remaining === 0 && <p>Estimated test window ended or a stop was acknowledged. This is <strong>not proof that motors have stopped</strong>.</p>}
      {state.reply && <p>{state.reply}</p>}
      {state.error && <p className="fail" role="alert">{state.error}</p>}
    </div>
    <p className="muted">No measured RPM, spin direction, or sequence progress is available. Stop waits for any in-flight USB command; navigation and hiding this page request a best-effort stop, not a guaranteed emergency shutdown. If anything keeps spinning, disconnect battery power.</p>
  </section>;
}
