import { useState } from "react";
import { useHost } from "../hooks/useHost";

/**
 * Configuration page — read-only status crumbs plus notes for settings that
 * live on other tabs. No buttons for features, orientation, motor protocol,
 * or mixer: those controls are not on this page.
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

const UNSUPPORTED_SECTIONS = [
  {
    id: "features",
    title: "Features",
    body: "Firmware has no features get/set command. Air mode is the PID tab setting airmode. There is no feature-flag control on this page.",
  },
  {
    id: "orientation",
    title: "Orientation",
    body: "Board alignment is set on the Sensors tab (align_board_roll, align_board_pitch, align_board_yaw). This page does not edit it.",
  },
  {
    id: "motor",
    title: "Motor protocol",
    body: "DShot 300/600 is set on the Motors tab (dshot 300 or dshot 600). This page does not edit it.",
  },
  {
    id: "mixer",
    title: "Mixer",
    body: "Firmware mixer is a read-only quad report. Motor direction is set on the Motors tab. There is no mixer-type control on this page.",
  },
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

      <div className="banner-warn" role="status" data-testid="configuration-unsupported">
        Features, orientation, motor protocol, and mixer are not edited on this page.
      </div>

      {UNSUPPORTED_SECTIONS.map((section) => (
        <section key={section.id} style={{ marginTop: "1rem" }} data-testid={`configuration-${section.id}`}>
          <h3>{section.title}</h3>
          <p>{section.body}</p>
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
