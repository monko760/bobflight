import { useState } from "react";
import { useHost } from "../hooks/useHost";

/**
 * Ports page — FW-locked surface.
 * Entire UART/USB port map is honest-disabled: FW has no port map API
 * (board IR fixed at build). Optional read-only crumbs from existing
 * CLI `status` only. No BF-style port grid; no invented UART role get/set.
 */

const PORT_CRUMB_FIELDS = ["rx", "dshot_bound", "board", "mcu"] as const;

type PortCrumbField = (typeof PORT_CRUMB_FIELDS)[number];

const PORT_MAP_DISABLED_REASON =
  "FW has no port map API yet (board IR fixed at build).";

export function PortsPage() {
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

  function fieldValue(key: PortCrumbField): string {
    if (!status) return "—";
    const val = status[key];
    return val === undefined || val === "" ? "—" : String(val);
  }

  /** Display helper: surface bound/unbound from existing rx status string. */
  function rxBoundLabel(rxRaw: string): string | null {
    if (rxRaw === "—") return null;
    const lower = rxRaw.toLowerCase();
    if (/\bunbound\b/.test(lower)) return "unbound";
    if (/\bbound\b/.test(lower)) return "bound";
    return null;
  }

  const rxVal = fieldValue("rx");
  const rxBound = rxBoundLabel(rxVal);

  return (
    <div className="panel">
      <h2>Ports</h2>
      <p className="muted">
        UART / USB function map. Board pinout is fixed in firmware IR at
        build — no runtime port remap CLI.
      </p>

      {!connected && (
        <p className="fail">Disconnected — connect on the Connect page first.</p>
      )}

      {/* Entire Ports map — honest-disabled (FW lock) */}
      <section style={{ marginTop: "1rem" }}>
        <h3>Port map</h3>
        <div className="banner-warn" role="status">
          Disabled: {PORT_MAP_DISABLED_REASON}
        </div>
        <div className="row" style={{ marginTop: "0.75rem", alignItems: "center" }}>
          <button
            type="button"
            className="primary"
            disabled
            title={`Disabled: ${PORT_MAP_DISABLED_REASON}`}
          >
            Configure ports…
          </button>
          <button
            type="button"
            className="ghost"
            disabled
            title={`Disabled: ${PORT_MAP_DISABLED_REASON}`}
          >
            Assign UART roles…
          </button>
        </div>
        <p className="muted">Disabled: {PORT_MAP_DISABLED_REASON}</p>
      </section>

      {/* Read-only crumbs from existing status only */}
      <section style={{ marginTop: "1.25rem" }}>
        <h3>Status crumbs</h3>
        <p className="muted">
          Read-only fields from CLI <code>status</code> (no editing; no port
          CLI keys).
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
          {PORT_CRUMB_FIELDS.map((key) => {
            const val = fieldValue(key);
            return (
              <div key={key} className="status-card">
                <div className="k">
                  {key}
                  {key === "rx" && rxBound ? ` (${rxBound})` : ""}
                </div>
                <div className="v">{val}</div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
