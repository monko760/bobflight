/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Motors tab, next to the pole count: `motor_direction` on the FC (schema 10).
 * It tells the mixer which way the props spin; it does not change the ESC
 * spin direction. Every set is followed by `get motor_direction` and `mixer`;
 * the selector returns to what the FC holds and a refusal is shown verbatim.
 *
 * Props (#63 Config Lead):
 *   ready  the host connect has completed (useHost connectionStatus "connected"
 *          AND pollAfterConnect has read the version). The panel reads only then,
 *          never on the raw client "connected" (R14: that reply arrives glued to
 *          the ready banner and parses as malformed).
 *   lock   a reason string (motorDirectionLock.ts) or null; any reason disables the
 *          selector and the button (armed / unknown arm, motor test, stop, storage
 *          pending, post-flash gate, not connected). FW refusals stay the backstop.
 * Only a real `motor_direction=<token>` reply enables the selector; a malformed
 * reply, a busy gate or a client error leaves it disabled with "Read again".
 * A disconnect clears the panel, aborts any read / apply and bumps a generation
 * token: a late result from before the disconnect is ignored (N1).
 * The busy gate (QA #60) is retried only for the gate's own refusal; if it stays
 * busy the value (or the mixer cells) show "unknown" with the gate's message
 * (never the older-FC banner) and "Read again" reads once more.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MOTOR_DIRECTION_BENCH_TEST, MOTOR_DIRECTION_COPY, MOTOR_DIRECTION_OPTIONS, isMotorDirectionOption, motorDirectionView, type MotorDirectionOption } from "../protocol";
import {
  MotorDirectionCancelled, applyMotorDirection, emptyMotorDirection, motorDirectionBusyMessage, motorDirectionErrorMessage, readMotorDirection, viewGet,
  type MotorDirectionHost, type MotorDirectionProblem, type MotorDirectionSnapshot,
} from "./motorDirection";

export function MotorDirectionPanel({ host, ready, lock }: { host: MotorDirectionHost; ready: boolean; lock: string | null }) {
  const [snap, setSnap] = useState<MotorDirectionSnapshot>(emptyMotorDirection);
  const [draft, setDraft] = useState<MotorDirectionOption | "">("");
  const [fcLine, setFcLine] = useState<string | null>(null);
  const [problem, setProblem] = useState<MotorDirectionProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  /** Bumped on disconnect / not ready / unmount: results started before are ignored (N1). */
  const gen = useRef(0);
  const readCtl = useRef<AbortController | null>(null);
  const applyCtl = useRef<AbortController | null>(null);
  const view = motorDirectionView(viewGet(snap.get), snap.report);
  const busyMsg = problem?.kind === "busy" ? problem.message : motorDirectionBusyMessage(snap);
  const errorMsg = problem?.kind === "error" ? problem.message : motorDirectionErrorMessage(snap);
  const linkUp = () => host.getConnectionStatus?.() === "connected";

  const reset = useCallback(() => {
    gen.current++;
    readCtl.current?.abort(); readCtl.current = null;
    applyCtl.current?.abort(); applyCtl.current = null;
    setSnap(emptyMotorDirection()); setDraft(""); setFcLine(null); setProblem(null); setBusy(false); setReading(false);
  }, []);
  const read = useCallback(async () => {
    if (!linkUp()) return;
    readCtl.current?.abort();
    const ctl = new AbortController(); readCtl.current = ctl;
    const g = gen.current;
    setReading(true);
    try {
      const next = await readMotorDirection(host, undefined, ctl.signal);
      if (ctl.signal.aborted || g !== gen.current || !linkUp()) return;
      setSnap(next);
      setDraft(motorDirectionView(viewGet(next.get), next.report).selected ?? "");
    } catch (e) {
      if (!(e instanceof MotorDirectionCancelled)) throw e;
    } finally {
      if (readCtl.current === ctl) { readCtl.current = null; if (g === gen.current) setReading(false); }
    }
  }, [host]);
  // Read once the host connect has completed; clear everything when it is not (or no longer) ready.
  useEffect(() => {
    if (!ready) { reset(); return; }
    void read();
    return () => { reset(); };
  }, [ready, read, reset]);
  // A raw disconnect clears at once (before React sees `ready` drop). A raw "connected" is NOT a read trigger (R14).
  useEffect(() => host.onStatus?.((s) => { if (s !== "connected") reset(); }), [host, reset]);

  const connected = ready && linkUp();
  const canSet = connected && view.supported === true && !busy && !reading && lock === null;
  async function apply() {
    if (!canSet || !isMotorDirectionOption(draft) || draft === view.held) return;
    const ctl = new AbortController(); applyCtl.current = ctl;
    const g = gen.current;
    setBusy(true); setFcLine(null); setProblem(null);
    try {
      const res = await applyMotorDirection(host, draft, ctl.signal);
      if (ctl.signal.aborted || g !== gen.current || !linkUp()) return; // late result (N1): ignored
      setSnap(res.snap);
      setDraft(motorDirectionView(viewGet(res.snap.get), res.snap.report).selected ?? "");
      if (res.fcLine !== null) setFcLine(res.fcLine);
      if (res.problem !== null) setProblem(res.problem);
    } catch (e) {
      if (!(e instanceof MotorDirectionCancelled)) throw e;
    } finally {
      if (applyCtl.current === ctl) applyCtl.current = null;
      if (g === gen.current) setBusy(false);
    }
  }

  return <section className="motor-option-panel" data-testid="motor-direction-fc"><h3>Motor direction</h3>
    <label htmlFor="motor-direction-fc">Prop direction the mixer assumes (<code>motor_direction</code> on the controller)</label>
    <div className="row"><select id="motor-direction-fc" aria-label="motor_direction" value={draft} disabled={!canSet}
      onChange={e => { setDraft(e.target.value as MotorDirectionOption | ""); setFcLine(null); setProblem(null); }}>
      {draft === "" && <option value="">—</option>}
      {MOTOR_DIRECTION_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
      <button disabled={!canSet || draft === "" || draft === view.held} onClick={() => void apply()}>Set direction on controller</button>
      <button className="ghost" disabled={!connected || busy || reading} onClick={() => { if (!connected || busy || reading) return; setFcLine(null); setProblem(null); void read(); }}>Read again</button></div>
    <p>Controller holds: <code data-motor-direction="held">{snap.get === null ? (connected ? "reading…" : "not connected") : view.held}</code></p>
    {lock !== null && <p className="muted" data-testid="motor-direction-lock">{lock}</p>}
    {busyMsg !== null && <p className="fail" data-testid="motor-direction-busy">{busyMsg}</p>}
    {errorMsg !== null && <p className="fail" data-testid="motor-direction-error">No controller reply: {errorMsg}</p>}
    {view.supported === false && <p className="banner-warn" data-testid="motor-direction-old-fc">This firmware has no <code>motor_direction</code> setting (older controller): unknown.</p>}
    {view.supported !== false && snap.get !== null && <table className="motor-direction-mixer"><tbody>
      <tr><th>Mixer reports</th><td><code data-motor-direction="mixer">{view.mixerDirection}</code></td></tr>
      {view.yaw.map((s, i) => <tr key={i}><th>Yaw sign M{i + 1}</th><td><code data-motor-direction={`yaw-m${i + 1}`}>{s}</code></td></tr>)}
    </tbody></table>}
    {fcLine !== null && <p className="fail" data-testid="motor-direction-fc-line">{fcLine}</p>}
    <p className="muted" data-testid="motor-direction-copy">{MOTOR_DIRECTION_COPY} Default props-out keeps the mixer exactly as before. Refused while armed or while a motor test runs; applies at once; Save to controller keeps it after reboot.</p>
    <p className="banner-warn" data-testid="motor-direction-bench">Bench test after any change: {MOTOR_DIRECTION_BENCH_TEST}</p>
  </section>;
}
