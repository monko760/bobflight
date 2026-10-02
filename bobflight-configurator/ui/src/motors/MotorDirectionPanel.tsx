/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Motors tab, next to the pole count: `motor_direction` on the FC (schema 10).
 * It tells the mixer which way the props spin; it does not change the ESC
 * spin direction. Every set is followed by `get motor_direction` and `mixer`;
 * the selector returns to what the FC holds and a refusal is shown verbatim.
 * `blocked` (Motors page: storageBlocked(state) || postFlashGate) disables the
 * selector and the button. An older FC shows "unknown" and nothing can be set.
 *
 * QA #60: the panel mounts while the Motors eRPM poll holds the command gate.
 * motorDirection.ts retries only the gate's refusal; if the gate stays busy the
 * value (or the mixer cells, if only the report stayed refused) shows
 * "unknown" with the gate's message (never the older-FC banner).
 * Unmount, a disconnect or a newer read aborts the retries, so nothing is sent
 * for an unmounted panel.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MOTOR_DIRECTION_BENCH_TEST, MOTOR_DIRECTION_COPY, MOTOR_DIRECTION_OPTIONS, isMotorDirectionOption, motorDirectionView, type MotorDirectionOption } from "../protocol";
import { MotorDirectionCancelled, applyMotorDirection, emptyMotorDirection, motorDirectionBusyMessage, readMotorDirection, viewGet, type MotorDirectionHost, type MotorDirectionSnapshot } from "./motorDirection";

export function MotorDirectionPanel({ host, blocked = false }: { host: MotorDirectionHost; blocked?: boolean }) {
  const [snap, setSnap] = useState<MotorDirectionSnapshot>(emptyMotorDirection);
  const [draft, setDraft] = useState<MotorDirectionOption | "">("");
  const [fcLine, setFcLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Aborted on unmount: stops an apply's gate retries. */
  const mounted = useRef<AbortController | null>(null);
  const view = motorDirectionView(viewGet(snap.get), snap.report);
  const busyMsg = motorDirectionBusyMessage(snap);

  const reload = useCallback(async (signal: AbortSignal) => {
    let next: MotorDirectionSnapshot;
    try {
      next = await readMotorDirection(host, undefined, signal);
    } catch (e) {
      if (e instanceof MotorDirectionCancelled) return;
      throw e;
    }
    if (signal.aborted) return;
    setSnap(next);
    setDraft(motorDirectionView(viewGet(next.get), next.report).selected ?? "");
  }, [host]);
  useEffect(() => {
    const life = new AbortController();
    mounted.current = life;
    let read: AbortController | null = null;
    const start = () => { read?.abort(); read = new AbortController(); void reload(read.signal); };
    let last = host.getConnectionStatus?.() ?? null;
    start();
    const off = host.onStatus?.((s) => {
      if (s === last) return;
      last = s;
      if (s === "connected") { start(); return; }
      read?.abort();
      setSnap(emptyMotorDirection());
      setDraft("");
      setFcLine(null);
    });
    return () => { off?.(); read?.abort(); life.abort(); };
  }, [host, reload]);

  const canSet = view.supported === true && !busy && !blocked;
  async function apply() {
    if (!canSet || !isMotorDirectionOption(draft) || draft === view.held) return;
    const signal = mounted.current?.signal;
    setBusy(true);
    setFcLine(null);
    try {
      const res = await applyMotorDirection(host, draft, signal);
      if (signal?.aborted) return;
      setSnap(res.snap);
      setDraft(motorDirectionView(viewGet(res.snap.get), res.snap.report).selected ?? "");
      if (!res.ok) setFcLine(res.fcLine);
    } catch (e) {
      if (!(e instanceof MotorDirectionCancelled)) throw e;
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }

  return <section className="motor-option-panel" data-testid="motor-direction-fc"><h3>Motor direction</h3>
    <label htmlFor="motor-direction-fc">Prop direction the mixer assumes (<code>motor_direction</code> on the controller)</label>
    <div className="row"><select id="motor-direction-fc" aria-label="motor_direction" value={draft} disabled={!canSet}
      onChange={e => { setDraft(e.target.value as MotorDirectionOption | ""); setFcLine(null); }}>
      {draft === "" && <option value="">—</option>}
      {MOTOR_DIRECTION_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
      <button disabled={!canSet || draft === "" || draft === view.held} onClick={() => void apply()}>Set direction on controller</button></div>
    <p>Controller holds: <code data-motor-direction="held">{snap.get === null ? "reading…" : view.held}</code></p>
    {busyMsg !== null && <p className="fail" data-testid="motor-direction-busy">{busyMsg}</p>}
    {view.supported === false && <p className="banner-warn" data-testid="motor-direction-old-fc">This firmware has no <code>motor_direction</code> setting (older controller): unknown.</p>}
    {view.supported !== false && snap.get !== null && <table className="motor-direction-mixer"><tbody>
      <tr><th>Mixer reports</th><td><code data-motor-direction="mixer">{view.mixerDirection}</code></td></tr>
      {view.yaw.map((s, i) => <tr key={i}><th>Yaw sign M{i + 1}</th><td><code data-motor-direction={`yaw-m${i + 1}`}>{s}</code></td></tr>)}
    </tbody></table>}
    {fcLine && <p className="fail" data-testid="motor-direction-fc-line">{fcLine}</p>}
    <p className="muted" data-testid="motor-direction-copy">{MOTOR_DIRECTION_COPY} Default props-out keeps the mixer exactly as before. Refused while armed or while a motor test runs; applies at once; Save to controller keeps it after reboot.</p>
    <p className="banner-warn" data-testid="motor-direction-bench">Bench test after any change: {MOTOR_DIRECTION_BENCH_TEST}</p>
  </section>;
}
