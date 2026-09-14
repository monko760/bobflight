import { useState } from "react";
import { useHost } from "../hooks/useHost";

/**
 * Failsafe page — FW-locked surface.
 * Read-only failsafe status (ok|ACTIVE) with no editable configuration.
 * Procedure/timeout editors honest-disabled — FW has no failsafe config API.
 * No invented BF failsafe commands.
 */

const FAILSAFE_DISABLED_REASON =
  "Firmware does not expose editable failsafe settings.";

const DISABLED_SECTIONS = [
  { id: "procedure", title: "Failsafe procedure", action: "Edit procedure…" },
  { id: "timeout", title: "RX-loss timeout", action: "Edit timeout…" },
] as const;

export function FailsafePage() {
  const { connectionStatus, status, refreshStatus, setLastError } = useHost();
  const [busy, setBusy] = useState(false);

  const connected = connectionStatus === "connected";
  const failsafeRaw =
    status?.failsafe === undefined || status.failsafe === ""
      ? null
      : String(status.failsafe);
  const failsafeWarn = failsafeRaw === "ACTIVE";

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
      <h2>Failsafe</h2>
      <p className="muted">
        Failsafe behavior is defined in firmware. This page displays status only;
        procedure and timeout settings are not editable or saved here.
      </p>

      {!connected && (
        <p className="fail">Disconnected — connect on the Connect page first.</p>
      )}

      <section style={{ marginTop: "1rem" }}>
        <h3>Status</h3>
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
          <div
            className={`status-card${failsafeWarn ? " status-card-warn" : ""}`}
          >
            <div className="k">failsafe</div>
            <div className="v">{failsafeRaw ?? "—"}</div>
          </div>
        </div>
        <p className="muted" style={{ marginTop: "0.75rem" }}>
          Status is a snapshot; refresh to read the controller again.
        </p>
      </section>

      <div className="banner-warn" role="status" style={{ marginTop: "1rem" }}>
        Disabled: {FAILSAFE_DISABLED_REASON}
      </div>

      {DISABLED_SECTIONS.map((section) => (
        <section key={section.id} style={{ marginTop: "1rem" }}>
          <h3>{section.title}</h3>
          <div className="row" style={{ alignItems: "center" }}>
            <button
              type="button"
              className="primary"
              disabled
              title={`Disabled: ${FAILSAFE_DISABLED_REASON}`}
            >
              {section.action}
            </button>
          </div>
          <p className="muted">Disabled: {FAILSAFE_DISABLED_REASON}</p>
        </section>
      ))}
    </div>
  );
}
