/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Setup: the FC's loop-rate reason (`loop_rate` report, `loop_rate_reason`),
 * shown exactly as sent. "unknown" when the FC did not send one (older FC, no
 * reading yet, malformed). Explanatory text comes only from the reported token
 * (protocol loopRateReasonView); nothing is inferred from bidir, board or rate.
 * The report is re-read after every selector action (readLoopRateSetting), so
 * this never shows an optimistic value.
 */
import { loopRateReasonView, type LoopRateReport } from "../protocol";

export function LoopRateReasonCard({ report, connected }: { report: LoopRateReport | null; connected: boolean }) {
  const view = loopRateReasonView(connected ? report : null);
  return (
    <div className="status-card" style={{ marginTop: "0.5rem" }} data-testid="loop-rate-reason">
      <div className="k">Loop-rate reason (as reported by the controller)</div>
      <div className="v">
        <code>{view.token}</code>
      </div>
      {connected && view.explanation !== null && <p className={view.fallback ? "banner-warn" : "muted"}>{view.explanation}</p>}
      {connected && view.explanation === null && report?.reason != null && (
        <p className="muted">This Configurator has no description for this reason; it is shown as the controller sent it.</p>
      )}
      {connected && report?.reason == null && (
        <p className="muted">The controller did not report a loop-rate reason: unknown.</p>
      )}
      {connected && <p className="muted">Read on connect and after every loop-rate action; use Re-read to refresh.</p>}
    </div>
  );
}
