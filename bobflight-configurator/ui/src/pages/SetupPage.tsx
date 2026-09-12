import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useHost } from "../hooks/useHost";
import { shouldDisableArm } from "../protocol";

/** Setup MVP status fields only (Lead lock). */
const SETUP_STATUS_FIELDS = [
  "board",
  "ir",
  "mcu",
  "gyro_ok",
  "gyro_bind",
  "arm",
  "failsafe",
] as const;

type SetupStatusField = (typeof SETUP_STATUS_FIELDS)[number];

export function SetupPage() {
  const {
    host,
    connectionStatus,
    version,
    status,
    refreshStatus,
    pollAfterConnect,
    setLastError,
  } = useHost();
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [confirmDefaults, setConfirmDefaults] = useState(false);

  const connected = connectionStatus === "connected";
  // restoreDefaults exists on BobFlightHost and is safe when connected (mock + serial).
  const canRestoreDefaults =
    connected && !busy && typeof host.restoreDefaults === "function";
  const defaultsDisabledReason = !connected
    ? "Disabled: connect first"
    : busy
      ? "Disabled: busy"
      : typeof host.restoreDefaults !== "function"
        ? "Disabled: restoreDefaults not available on this host"
        : null;

  async function onRefresh() {
    if (!connected || busy) return;
    setBusy(true);
    setActionErr(null);
    setLastError(null);
    try {
      // Re-fetch version + status via existing host APIs (no new commands).
      await pollAfterConnect();
      await refreshStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setActionErr(msg);
    } finally {
      setBusy(false);
    }
  }

  async function onRestoreDefaults() {
    if (!canRestoreDefaults) return;
    setBusy(true);
    setActionMsg(null);
    setActionErr(null);
    setLastError(null);
    setConfirmDefaults(false);
    try {
      await host.restoreDefaults();
      setActionMsg("defaults restored");
      if (host.getConnectionStatus() === "connected") {
        await refreshStatus();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setActionErr(msg);
    } finally {
      setBusy(false);
    }
  }

  const armBlocked = shouldDisableArm(status);
  const blockerReasons: string[] =
    status?.failClosedReasons?.length
      ? status.failClosedReasons
      : [
          ...(status?.gyro_ok === "no" ? ["gyro_ok:no"] : []),
          ...(status?.failsafe === "ACTIVE" ? ["failsafe:ACTIVE"] : []),
        ];

  function fieldValue(key: SetupStatusField): string {
    if (!status) return "—";
    const val = status[key];
    return val === undefined || val === "" ? "—" : String(val);
  }

  function fieldWarn(key: SetupStatusField, val: string): boolean {
    return (
      (key === "gyro_ok" && val === "no") ||
      (key === "failsafe" && val === "ACTIVE")
    );
  }

  return (
    <div className="panel">
      <h2>Setup</h2>
      <p className="muted">
        Phase A setup: CLI version, board status, honest calibrate gate, restore
        defaults, and fail-closed arming blockers.
      </p>

      {connected ? (
        <div className="banner-info" role="status">
          Ready on connect. CLI/CDC is available only after leave-DFU (not while
          the board is in DFU mode).
        </div>
      ) : (
        <p className="fail">
          Disconnected — connect on the Connect page first.
        </p>
      )}

      {/* Version — CLI `version` string from host context */}
      <section style={{ marginTop: "1rem" }}>
        <h3>Version</h3>
        <div className="row" style={{ alignItems: "center" }}>
          <div>
            <span className="muted">CLI version</span>
            <div className="v">{connected ? (version ?? "—") : "—"}</div>
          </div>
          <button
            type="button"
            className="ghost"
            disabled={!connected || busy}
            onClick={() => void onRefresh()}
          >
            Refresh
          </button>
        </div>
      </section>

      {/* Status subset (Lead lock) */}
      <section style={{ marginTop: "1.25rem" }}>
        <h3>Status</h3>
        <p className="muted">
          Fields from CLI <code>status</code> (Setup subset).
        </p>
        <div className="status-grid">
          {SETUP_STATUS_FIELDS.map((key) => {
            const val = fieldValue(key);
            const warn = fieldWarn(key, val);
            return (
              <div
                key={key}
                className={`status-card${warn ? " status-card-warn" : ""}`}
              >
                <div className="k">{key}</div>
                <div className="v">{val}</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Accel calibrate — honest disable only; no CLI yet */}
      <section style={{ marginTop: "1.25rem" }}>
        <h3>Accel calibrate</h3>
        <div className="row" style={{ alignItems: "center" }}>
          <button
            type="button"
            className="primary"
            disabled
            title="Disabled: FW CLI calibrate not exposed yet (waiting FW Lead)"
          >
            Calibrate accel…
          </button>
        </div>
        <p className="muted">
          Disabled: FW CLI calibrate not exposed yet (waiting FW Lead)
        </p>
      </section>

      {/* Reset / defaults */}
      <section style={{ marginTop: "1.25rem" }}>
        <h3>Reset / defaults</h3>
        <p className="muted">
          Uses host <code>restoreDefaults()</code> when connected (all 12 FW
          settings keys; no auto-save).
        </p>
        <div className="row">
          <button
            type="button"
            className="danger"
            disabled={!canRestoreDefaults}
            title={defaultsDisabledReason ?? undefined}
            onClick={() => setConfirmDefaults(true)}
          >
            Restore defaults…
          </button>
        </div>
        {defaultsDisabledReason && (
          <p className="muted">{defaultsDisabledReason}</p>
        )}
      </section>

      {/* Arming blockers — gyro_ok:no and/or failsafe:ACTIVE only */}
      <section style={{ marginTop: "1.25rem" }}>
        <h3>Arming blockers</h3>
        <p className="muted">
          Fail-closed (gyro_ok:no or failsafe:ACTIVE only) via{" "}
          <code>shouldDisableArm</code> / <code>failClosedReasons</code> —
          shown even when not arming.
        </p>
        {!connected && (
          <p className="muted">Connect to load status blockers.</p>
        )}
        {connected && !status && (
          <p className="muted">
            No status yet — use Refresh after connect.
          </p>
        )}
        {connected && status && !status.failClosed && !armBlocked && (
          <p className="muted">No fail-closed arming blockers.</p>
        )}
        {connected && (status?.failClosed || armBlocked) && (
          <div className="fail" role="alert">
            <strong>Fail-closed blocks</strong>
            <ul>
              {(blockerReasons.length
                ? blockerReasons
                : ["status unavailable"]
              ).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {armBlocked && (
              <p>Arm is refused while gyro_ok:no or failsafe:ACTIVE.</p>
            )}
          </div>
        )}
      </section>

      {actionMsg && <p className="muted">Last reply: {actionMsg}</p>}
      {actionErr && <p className="fail">{actionErr}</p>}

      {confirmDefaults && (
        <ConfirmDialog
          open
          title="Restore defaults?"
          message="Restore all firmware settings defaults via host.restoreDefaults()? This resets all 12 settings keys. Changes are not auto-saved."
          confirmLabel="Restore defaults"
          danger
          onCancel={() => setConfirmDefaults(false)}
          onConfirm={() => void onRestoreDefaults()}
        />
      )}
    </div>
  );
}
