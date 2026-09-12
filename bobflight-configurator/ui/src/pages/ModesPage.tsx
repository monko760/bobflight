import { useState } from "react";
import { useHost } from "../hooks/useHost";

/**
 * Modes page — FW-locked surface.
 * Entire Modes/aux map honest-disabled: FW has no aux/modes API yet
 * (arm only via CLI/status). Optional read-only arm from status.
 * No invented BF aux/mode commands.
 */

const MODES_DISABLED_REASON =
  "FW has no aux/modes API yet (arm only via CLI/status).";

export function ModesPage() {
  const { connectionStatus, status, refreshStatus, setLastError } = useHost();
  const [busy, setBusy] = useState(false);

  const connected = connectionStatus === "connected";
  const armRaw =
    status?.arm === undefined || status.arm === ""
      ? null
      : String(status.arm);

  async function onRefresh() {
    if (!connected || busy) return;
    setBusy(true);
    setLastError(null);
    try {
      await refreshStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Modes</h2>
      <p className="muted">
        Aux mode ranges and switches. Skeleton firmware has no aux/modes API —
        arming is CLI/status only.
      </p>

      {!connected && (
        <p className="fail">Disconnected — connect on the Connect page first.</p>
      )}

      <section style={{ marginTop: "1rem" }}>
        <h3>Arm (read-only)</h3>
        <div className="row" style={{ alignItems: "center" }}>
          <button
            type="button"
            className="ghost"
            disabled={!connected || busy}
            onClick={() => void onRefresh()}
          >
            Refresh status
          </button>
        </div>
        <div className="status-grid" style={{ marginTop: "0.75rem" }}>
          <div className="status-card">
            <div className="k">arm</div>
            <div className="v">{armRaw ?? "—"}</div>
          </div>
        </div>
      </section>

      <div className="banner-warn" role="status" style={{ marginTop: "1rem" }}>
        Disabled: {MODES_DISABLED_REASON}
      </div>

      <section style={{ marginTop: "1rem" }}>
        <h3>Modes map</h3>
        <div className="row" style={{ alignItems: "center" }}>
          <button
            type="button"
            className="primary"
            disabled
            title={`Disabled: ${MODES_DISABLED_REASON}`}
          >
            Edit modes…
          </button>
          <button
            type="button"
            className="ghost"
            disabled
            title={`Disabled: ${MODES_DISABLED_REASON}`}
          >
            Assign aux ranges…
          </button>
        </div>
        <p className="muted">Disabled: {MODES_DISABLED_REASON}</p>
      </section>
    </div>
  );
}
