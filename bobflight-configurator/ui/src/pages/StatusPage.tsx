import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useHost } from "../hooks/useHost";
import { shouldDisableArm, type CliCommand } from "../protocol";

type PendingAction = "arm" | "disarm" | "reboot" | null;

const STATUS_FIELDS = [
  "board",
  "ir",
  "mcu",
  "gyro_ok",
  "gyro_bind",
  "dshot_bound",
  "rx",
  "mmio",
  "arm",
  "failsafe",
  "loop",
] as const;

export function StatusPage() {
  const {
    host,
    connectionStatus,
    version,
    status,
    refreshStatus,
    setLastError,
  } = useHost();
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const connected = connectionStatus === "connected";
  const armDisabled =
    !connected || busy || shouldDisableArm(status) || status?.arm === "armed";
  const disarmDisabled = !connected || busy || status?.arm !== "armed";

  async function runConfirmed(cmd: CliCommand) {
    setBusy(true);
    setActionMsg(null);
    setLastError(null);
    try {
      const reply = await host.sendCommand(cmd);
      setActionMsg(reply.split(/\r?\n/).filter(Boolean).join(" | "));
      if (cmd !== "reboot" && host.getConnectionStatus() === "connected") {
        await refreshStatus();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setActionMsg(msg);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const confirmCopy: Record<
    Exclude<PendingAction, null>,
    { title: string; message: string; label: string; danger?: boolean }
  > = {
    arm: {
      title: "Confirm arm",
      message:
        "Send the exact CLI command 'arm'? This will only succeed if the flight controller is ready. Never auto-armed on connect.",
      label: "Send arm",
      danger: true,
    },
    disarm: {
      title: "Confirm disarm",
      message: "Send the exact CLI command 'disarm'?",
      label: "Send disarm",
    },
    reboot: {
      title: "Confirm reboot",
      message:
        "Send 'reboot'? The link will drop and you must reconnect (banner shown again).",
      label: "Send reboot",
      danger: true,
    },
  };

  return (
    <div className="panel">
      <h2>Status</h2>
      <p className="muted">
        Live FC status from CLI <code>version</code> and <code>status</code>.
        Fail-closed gates are shown explicitly; Arm stays disabled when unsafe.
      </p>

      {!connected && (
        <p className="fail">Disconnected — connect on the Connect page first.</p>
      )}

      <div className="row" style={{ alignItems: "center" }}>
        <div>
          <span className="muted">Version</span>
          <div className="v">{version ?? "—"}</div>
        </div>
        <button
          type="button"
          className="ghost"
          disabled={!connected || busy}
          onClick={() => void refreshStatus()}
        >
          Refresh status
        </button>
      </div>

      <div className="status-grid">
        {STATUS_FIELDS.map((key) => {
          const val = status?.[key] ?? "—";
          const warn =
            (key === "gyro_ok" && val === "no") ||
            (key === "failsafe" && val === "ACTIVE");
          return (
            <div
              key={key}
              className={`status-card${warn ? " status-card-warn" : ""}`}
            >
              <div className="k">{key}</div>
              <div className="v">{String(val)}</div>
            </div>
          );
        })}
      </div>

      {status?.failClosed && (
        <div className="fail" role="alert">
          <strong>Fail-closed blocks</strong>
          <ul>
            {status.failClosedReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {shouldDisableArm(status) && (
            <p>Arm is disabled while gyro_ok:no or failsafe:ACTIVE.</p>
          )}
        </div>
      )}

      <div className="row" style={{ marginTop: "1rem" }}>
        <button
          type="button"
          className="danger"
          disabled={armDisabled}
          onClick={() => setPending("arm")}
          title={
            shouldDisableArm(status)
              ? "Disabled: gyro_ok:no or failsafe:ACTIVE"
              : undefined
          }
        >
          Arm…
        </button>
        <button
          type="button"
          className="primary"
          disabled={disarmDisabled}
          onClick={() => setPending("disarm")}
        >
          Disarm…
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!connected || busy}
          onClick={() => setPending("reboot")}
        >
          Reboot…
        </button>
      </div>

      {actionMsg && <p className="muted">Last action reply: {actionMsg}</p>}

      {status?.raw && (
        <details style={{ marginTop: "1rem" }}>
          <summary className="muted">Raw status</summary>
          <pre className="console">{status.raw}</pre>
        </details>
      )}

      {pending && (
        <ConfirmDialog
          open
          title={confirmCopy[pending].title}
          message={confirmCopy[pending].message}
          confirmLabel={confirmCopy[pending].label}
          danger={confirmCopy[pending].danger}
          onCancel={() => setPending(null)}
          onConfirm={() => void runConfirmed(pending)}
        />
      )}
    </div>
  );
}
