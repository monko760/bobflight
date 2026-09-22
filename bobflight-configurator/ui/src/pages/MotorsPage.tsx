import {StoragePanel} from "../components/StoragePanel";
/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState } from "react";
import { useHost } from "../hooks/useHost";
import { BenchController, benchBlockReason, MOTOR_POSITIONS, MAX_PULSE_PERCENT, type BenchState } from "../motors/benchController";

import { browserPoleStorage, readMotorPoles, storeMotorPoles, validMotorPoles } from "../motors/motorPoles";

export function MotorsPage() {
  const { host, postFlashGate } = useHost();
  const [poleCount, setPoleCount] = useState(() => readMotorPoles(browserPoleStorage()));
  const [poleDraft, setPoleDraft] = useState(() => String(poleCount));
  const [poleMessage, setPoleMessage] = useState("");
  const savePoles = () => {
    const value = Number(poleDraft);
    if (!validMotorPoles(value)) return;
    const saved = storeMotorPoles(value, browserPoleStorage());
    setPoleCount(value);
    setPoleMessage(saved ? "Pole count saved in this browser." : "Using this value for this page session only: browser storage is unavailable.");
  };
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
    <StoragePanel requiredScope="dshot" revision={state.rate??0} blocked={state.busy||state.stopping}/>
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
    <p className="muted">Sliders prepare a command only—they never start a motor by themselves. The full 0–{MAX_PULSE_PERCENT}% command range requires an explicit one-second test. Full command can spin a motor extremely fast: remove all props and secure the frame. No continuous throttle or master slider.</p>
    {capability && !capability.pulse && <p className="banner-warn">Adjustable sliders need firmware with motor_pulse support. Your current firmware can still use the fixed 8% tests below. Updating only this configurator does not add firmware support.</p>}
    <div className="motor-workspace">
      <div className="motor-map" aria-label="Motor positions viewed from above; front at the top">
        <div className="motor-front">↑ FRONT · TOP VIEW</div>
        {MOTOR_POSITIONS.map(({ motor, name, position }) => <div key={motor} className={`motor-card ${position}`}>
          <span className="motor-number">M{motor}</span><strong>{name}</strong>
          <div className="motor-rpm"><span>eRPM</span><strong aria-label={state.erpm[motor].value !== null ? `Motor ${motor} eRPM ${state.erpm[motor].value}` : `Motor ${motor} eRPM unavailable`}>{state.erpm[motor].value !== null ? state.erpm[motor].value : "—"}</strong><small>{state.erpm[motor].detail}</small></div>
          <label className="motor-slider-label" htmlFor={`motor-level-${motor}`}>Prepared command <output>{state.pulsePercent[motor]}%</output></label>
          <input className="motor-level" id={`motor-level-${motor}`} type="range" min="0" max={MAX_PULSE_PERCENT} step="1" value={state.pulsePercent[motor]}
            aria-valuetext={`${state.pulsePercent[motor]} percent command; not RPM or measured power`}
            disabled={!state.connected || !capability?.pulse || !state.visible || state.actionPending || state.stopping || remaining > 0 || (!!state.testLabel && !state.stationary)}
            onChange={e => controller.setPulsePercent(motor, Number(e.target.value))} />
          <div className="motor-slider-scale"><span>0%</span><span>{MAX_PULSE_PERCENT}% command</span></div>
          {capability?.pulse
            ? <button disabled={disabled || state.pulsePercent[motor] === 0} onClick={() => void controller.pulse(motor)}>Test M{motor} · {state.pulsePercent[motor]}% · 1s</button>
            : <button disabled={disabled || !capability?.individual} onClick={() => void controller.start(motor)}>Test M{motor} · fixed 8% · 1s</button>}
          <span className="muted">Changing the slider does not spin the motor.</span>
        </div>)}
        <div className="motor-map-caption">Expected wiring layout—not detected motor positions. Observe CW / CCW yourself; no direction reversal command is provided.</div>
      </div>
      <div className="motor-options">
        <section className="motor-option-panel"><h3>DShot bit rate</h3>
          <p>Current: <strong>{rate}</strong></p>
          <div className="row">{([300, 600] as const).map(value => <button key={value} aria-pressed={state.rate === value} disabled={disabled || !capability?.dshot || state.rate === value} onClick={() => void controller.setRate(value)}>DShot{value}</button>)}</div>
          <p className="muted">Choose only a rate your ESC supports. Changes are read back from the controller then retained after reboot with Save to controller. Motors must be stationary before switching.</p>
          {capability && !capability.dshot && <p className="banner-warn">Rate selection is unavailable on this firmware. No rate is assumed.</p>}
        </section>
        <section className="motor-option-panel"><h3>Motor pole count</h3>
          <label htmlFor="motor-poles">Magnetic poles · all four motors</label>
          <div className="row"><input id="motor-poles" type="number" min="2" max="60" step="2" value={poleDraft}
            onChange={e => setPoleDraft(e.target.value)} aria-invalid={!validMotorPoles(Number(poleDraft))} />
            <button disabled={!validMotorPoles(Number(poleDraft))} onClick={savePoles}>Save pole count</button></div>
          <p>Current: <strong>{poleCount} poles · {poleCount / 2} pole pairs</strong></p>
          {!validMotorPoles(Number(poleDraft)) && <p className="banner-warn">Enter an even whole number from 2 to 60.</p>}
          <p className="muted">Defaults to 14, common for 2306 FPV motors. Verify your motor specifications. This preference is local to this browser, shared across aircraft, and is not written to the flight controller. It does not change motor output or enable RPM telemetry.</p>
          {poleMessage && <p role="status">{poleMessage}</p>}
        </section>
        <section className="motor-option-panel"><h3>eRPM &amp; bidirectional DShot</h3>
          <p><strong>M1 eRPM telemetry (R0b).</strong> When bidirectional DShot is enabled on the controller and M1 telem is OK, the M1 cell shows live electrical RPM. M2–M4 stay unavailable until firmware R0c indexed telem.</p>
          <p className="muted">Cells never invent zeros or slider estimates. Enable bidir explicitly via CLI (<code>set dshot_bidir on</code>) — this page does not auto-enable it. Mechanical RPM still needs a confirmed motor pole count. Full four-motor telem is not claimed yet.</p>
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
    <p className="muted">eRPM is shown only from controller telem (M1 on R0b). No spin direction or sequence progress is measured. Stop waits for any in-flight USB command; navigation and hiding this page request a best-effort stop, not a guaranteed emergency shutdown. If anything keeps spinning, disconnect battery power.</p>
  </section>;
}
