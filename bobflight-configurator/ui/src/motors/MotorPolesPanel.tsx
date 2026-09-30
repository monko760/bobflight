/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Motor pole count on the FC (`motor_poles`, FW schema 9; the RPM filter uses
 * it to turn eRPM into motor Hz on the FC). Every set is followed by
 * `get motor_poles` and `rpm_filter`; the input returns to what the FC holds
 * and a refusal is shown verbatim. An older FC ("unknown key") keeps the
 * browser-only preference passed as `fallback`.
 *
 * `blocked` (Motors page: a bench action/stop in flight, or the post-flash
 * gate) disables the input and the button. The button is also disabled while
 * the client hint shows (13, 38, ...): nothing is sent for an invalid draft.
 * The FC value is re-read whenever the connection status changes.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { rpmValueProblem, type RpmFilterReportResult, type RpmGetResult } from "../protocol";
import { applyRpmSetting, emptyRpmSnapshot, readRpmKey, readRpmReport, type RpmHost, type RpmSnapshot } from "../filters/rpmFilter";

export function MotorPolesPanel({ host, fallback, blocked = false }: { host: RpmHost; fallback: ReactNode; blocked?: boolean }) {
  const [snap, setSnap] = useState<RpmSnapshot>(emptyRpmSnapshot);
  const [draft, setDraft] = useState("");
  const [fcLine, setFcLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const show = (v: RpmGetResult | null) => (v?.kind === "value" ? v.value : "");

  const reload = useCallback(async () => {
    const value = await readRpmKey(host, "motor_poles");
    const report: RpmFilterReportResult | null = value.kind === "value" ? await readRpmReport(host) : null;
    const next = { ...emptyRpmSnapshot(), values: { ...emptyRpmSnapshot().values, motor_poles: value }, report };
    setSnap(next);
    setDraft(show(value));
  }, [host]);
  useEffect(() => {
    let last = host.getConnectionStatus?.() ?? null;
    void reload();
    const off = host.onStatus?.((s) => {
      if (s === last) return;
      last = s;
      if (s === "connected") { void reload(); return; }
      // Not connected: nothing is known about the FC any more (never keep a stale value).
      setSnap(emptyRpmSnapshot());
      setDraft("");
      setFcLine(null);
    });
    return () => { off?.(); };
  }, [host, reload]);

  const value = snap.values.motor_poles;
  if (value?.kind === "unsupported") return <>{fallback}</>;
  const held = show(value);
  const n = /^\d+$/.test(draft.trim()) ? Number(draft.trim()) : NaN;
  const hint = draft.trim() !== held ? (Number.isFinite(n) ? rpmValueProblem("motor_poles", n) : "Use an even pole count from 4 to 36.") : null;
  const reason = snap.report?.kind === "report" ? snap.report.report.reason : null;

  async function apply() {
    if (!Number.isFinite(n) || blocked || hint) return;
    setBusy(true);
    setFcLine(null);
    try {
      const res = await applyRpmSetting(host, snap, "motor_poles", n);
      setSnap(res.snap);
      setDraft(show(res.snap.values.motor_poles));
      if (!res.ok) setFcLine(res.fcLine);
    } finally {
      setBusy(false);
    }
  }

  return <section className="motor-option-panel" data-testid="motor-poles-fc"><h3>Motor pole count</h3>
    <label htmlFor="motor-poles-fc">Magnetic poles · all four motors (<code>motor_poles</code> on the controller)</label>
    <div className="row"><input id="motor-poles-fc" aria-label="motor_poles" type="text" inputMode="numeric" value={draft}
      disabled={value?.kind !== "value" || busy || blocked} onChange={e => { setDraft(e.target.value); setFcLine(null); }} />
      <button disabled={value?.kind !== "value" || busy || blocked || draft.trim() === held || !Number.isFinite(n) || !!hint} onClick={() => void apply()}>Set on controller</button></div>
    <p>Controller holds: <code data-rpm="motor_poles">{value?.kind === "value" ? value.value : value ? "unknown" : "reading…"}</code>
      {reason && <> · RPM filter: <code data-rpm="reason">{reason}</code></>}</p>
    {hint && <p className="banner-warn" data-testid="motor-poles-hint">{hint}</p>}
    {fcLine && <p className="fail" data-testid="motor-poles-fc-line">{fcLine}</p>}
    <p className="muted">Even number from 4 to 36; 14 is common for 2306 motors. The RPM filter on the controller uses it to turn eRPM into motor Hz. Refused while armed; Save to controller keeps it after reboot. It does not change motor output or enable bidirectional DShot.</p>
  </section>;
}
