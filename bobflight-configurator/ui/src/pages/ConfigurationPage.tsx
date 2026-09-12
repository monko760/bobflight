import { useState } from "react";
import { useHost } from "../hooks/useHost";

/**
 * Configuration page — FW-locked surface.
 * Features / Orientation / Motor protocol / Mixer are honest-disabled:
 * FW has no Configuration get/set yet. Optional read-only crumbs from
 * existing CLI `status` only. Rate/PID editors stay on Rates/PID tabs.
 */

const CONFIG_CRUMB_FIELDS = [
  "board",
  "mcu",
  "ir",
  "dshot_bound",
  "rx",
  "gyro_bind",
] as const;

type ConfigCrumbField = (typeof CONFIG_CRUMB_FIELDS)[number];

const CONFIG_DISABLED_REASON = "FW has no Configuration get/set yet.";

const DISABLED_SECTIONS = [
  { id: "features", title: "Features", action: "Edit features…" },
  { id: "orientation", title: "Orientation", action: "Set orientation…" },
  {
    id: "motor",
    title: "Motor protocol",
    action: "Configure motor protocol…",
  },
  { id: "mixer", title: "Mixer", action: "Configure mixer…" },
] as const;

export function ConfigurationPage() {
  const { connectionStatus, status, refreshStatus, setLastError } = useHost();
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

  function fieldValue(key: ConfigCrumbField): string {
    if (!status) return "—";
    const val = status[key];
    return val === undefined || val === "" ? "—" : String(val);
  }

  return (
    <div className="panel">
      <h2>Configuration</h2>
      <p className="muted">
        Board features, orientation, motor protocol, and mixer. Rate and PID
        editors stay on the Rates and PID tabs — not duplicated here.
      </p>

      {!connected && (
        <p className="fail">Disconnected — connect on the Connect page first.</p>
      )}

      <div className="banner-warn" role="status">
        Disabled: {CONFIG_DISABLED_REASON}
      </div>

      {DISABLED_SECTIONS.map((section) => (
        <section key={section.id} style={{ marginTop: "1rem" }}>
          <h3>{section.title}</h3>
          <div className="row" style={{ alignItems: "center" }}>
            <button
              type="button"
              className="primary"
              disabled
              title={`Disabled: ${CONFIG_DISABLED_REASON}`}
            >
              {section.action}
            </button>
          </div>
          <p className="muted">Disabled: {CONFIG_DISABLED_REASON}</p>
        </section>
      ))}

      <section style={{ marginTop: "1.25rem" }}>
        <h3>Status crumbs</h3>
        <p className="muted">
          Read-only fields from CLI <code>status</code> (no Configuration
          get/set).
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
        {!connected && (
          <p className="muted">Connect to load status crumbs.</p>
        )}
        {connected && !status && (
          <p className="muted">No status yet — use Refresh after connect.</p>
        )}
        <div className="status-grid">
          {CONFIG_CRUMB_FIELDS.map((key) => (
            <div key={key} className="status-card">
              <div className="k">{key}</div>
              <div className="v">{fieldValue(key)}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
