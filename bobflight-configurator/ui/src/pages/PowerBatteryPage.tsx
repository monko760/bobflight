import { useState } from "react";
import { useHost } from "../hooks/useHost";

/**
 * Power & Battery page — FW-locked surface.
 * Entire power/battery editors are honest-disabled: FW has no
 * power/battery API yet (no ADC/VBAT in skeleton). No invented
 * BF vbat_* or current_meter commands. No Rates/PID keys here.
 */

const POWER_DISABLED_REASON =
  "FW has no power/battery API yet (no ADC/VBAT in skeleton).";

const DISABLED_SECTIONS = [
  { id: "vbat", title: "Battery voltage", action: "Configure VBAT…" },
  { id: "current", title: "Current meter", action: "Configure current meter…" },
  { id: "capacity", title: "Capacity / warnings", action: "Configure capacity…" },
] as const;

export function PowerBatteryPage() {
  const { connectionStatus, refreshStatus, setLastError } = useHost();
  const [busy, setBusy] = useState(false);

  const connected = connectionStatus === "connected";

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
      <h2>Power &amp; Battery</h2>
      <p className="muted">
        Voltage, current, and capacity settings. Skeleton firmware has no ADC /
        VBAT surface yet — editors stay honest-disabled.
      </p>

      {!connected && (
        <p className="fail">Disconnected — connect on the Connect page first.</p>
      )}

      <div className="banner-warn" role="status">
        Disabled: {POWER_DISABLED_REASON}
      </div>

      {DISABLED_SECTIONS.map((section) => (
        <section key={section.id} style={{ marginTop: "1rem" }}>
          <h3>{section.title}</h3>
          <div className="row" style={{ alignItems: "center" }}>
            <button
              type="button"
              className="primary"
              disabled
              title={`Disabled: ${POWER_DISABLED_REASON}`}
            >
              {section.action}
            </button>
          </div>
          <p className="muted">Disabled: {POWER_DISABLED_REASON}</p>
        </section>
      ))}

      <section style={{ marginTop: "1.25rem" }}>
        <h3>Link</h3>
        <p className="muted">
          No power/battery status fields in FW yet. Refresh only reloads
          existing CLI <code>status</code> (no ADC crumbs).
        </p>
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
      </section>
    </div>
  );
}
