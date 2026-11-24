import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useHost } from "../hooks/useHost";
import { ARM_CLI_OLDER_FIRMWARE_TEXT, armCliIsCheckOnly, parseArmReply, parseStatus, type ArmReply } from "@bobflight/protocol";
import { shouldDisableArm, statusArmRefusal, type CliCommand } from "../protocol";

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
  "arm_cli",
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
  const [armCheck, setArmCheck] = useState<ArmReply | null>(null);

  const connected = connectionStatus === "connected";
  // N2 capability: only firmware reporting `arm_cli: check` is check-only.
  // Older firmware really arms on `arm`, so Arm check is never offered there.
  const armCliCheck = armCliIsCheckOnly(status);
  const olderFirmware = !!status && !armCliCheck;
  const armDisabled =
    !connected || busy || !armCliCheck || shouldDisableArm(status) || status?.arm === "armed";
  const statusRefusal = armCliCheck ? statusArmRefusal(status) : null;
  const disarmDisabled = !connected || busy || status?.arm !== "armed";

  async function runConfirmed(cmd: CliCommand) {
    setBusy(true);
    setActionMsg(null);
    setLastError(null);
    if (cmd === "arm") setArmCheck(null);
    try {
      if (cmd === "arm") {
        // Re-read `status` right before sending: the board may have changed
        // since the last read. Never send `arm` without `arm_cli: check`.
        const fresh = parseStatus(await host.sendCommand("status"));
        if (!armCliIsCheckOnly(fresh)) {
          setActionMsg(`arm not sent. ${ARM_CLI_OLDER_FIRMWARE_TEXT}`);
          if (host.getConnectionStatus() === "connected") await refreshStatus();
          return;
        }
      }
      const reply = await host.sendCommand(cmd);
      setActionMsg(reply.split(/\r?\n/).filter(Boolean).join(" | "));
      if (cmd === "arm") setArmCheck(parseArmReply(reply));
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
      title: "Confirm arm check",
      message:
        "Run an arm check? The exact CLI command 'arm' is sent only after status is re-read and still reports arm_cli: check. This firmware never arms from USB: it runs the same checks as the radio ARM switch and replies with the first one that blocks arming. Arm with the radio ARM switch (off, then on). Never sent automatically.",
      label: "Run arm check",
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
        </div>
      )}

      <div className="row" style={{ marginTop: "1rem" }}>
        <button
          type="button"
          className="danger"
          disabled={armDisabled}
          onClick={() => setPending("arm")}
          title={
            olderFirmware
              ? ARM_CLI_OLDER_FIRMWARE_TEXT
              : statusRefusal
                ? statusRefusal
                : "Sends 'arm': the reply names the first check that blocks arming"
          }
        >
          Arm check…
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

      {olderFirmware ? (
        <p className="fail" data-testid="arm-cli-older" role="alert">
          {ARM_CLI_OLDER_FIRMWARE_TEXT}
        </p>
      ) : (
        <p className="muted" data-testid="arm-gate-note">
          USB never arms: only the radio ARM switch arms (switch it off, then on),
          through the same checks. Arm check sends <code>arm</code> and shows the
          first check that blocks arming.
        </p>
      )}
      {statusRefusal && (
        <p className="muted" data-testid="arm-status-refusal">
          Arm check: {statusRefusal}. Only a reply the board actually sends
          is shown here.
        </p>
      )}

      {armCheck && (
        <div className={armCheck.kind === "legacy-armed" ? "fail" : "muted"} data-testid="arm-check-reply" role="status">
          <div>
            Last arm check reply: <code data-testid="arm-check-line">{armCheck.line || "(no reply)"}</code>
          </div>
          {armCheck.explanation && <div data-testid="arm-check-explanation">{armCheck.explanation}</div>}
        </div>
      )}

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
