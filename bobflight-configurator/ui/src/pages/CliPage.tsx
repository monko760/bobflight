import { FormEvent, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useHost } from "../hooks/useHost";
import {
  ALLOWED_CLI_COMMANDS, parseCliInput, isBootloaderCommand,
  type CliCommand,
} from "../protocol";

export function CliPage() {
  const { host, connectionStatus, cliLines, appendCli, refreshStatus } =
    useHost();
  const [input, setInput] = useState("");
  const [uiMessage, setUiMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<CliCommand | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const connected = connectionStatus === "connected";

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [cliLines]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setUiMessage(null);
    if (!connected) {
      setUiMessage("Not connected.");
      return;
    }
    const cmd = parseCliInput(input);
    if (!cmd) {
      setUiMessage(
        "Rejected: command not allowlisted. Exact verbs plus patterned get/set for erpm_m1..m4, dshot_telem_m1..m4, and dshot_bidir (on|off) are accepted.",
      );
      return;
    }
    if (cmd === "arm" || cmd === "disarm" || cmd === "reboot" || cmd === "bench_switch" || isBootloaderCommand(cmd)) {
      setPending(cmd);
      return;
    }
    void send(cmd);
  }

  async function send(cmd: CliCommand) {
    setPending(null);
    setInput("");
    try {
      const reply = await host.sendCommand(cmd);
      if (isBootloaderCommand(cmd) && /bl: resetting to ST ROM bootloader/.test(reply)) {
        appendCli("[bootloader] Reset acknowledged; verify STM32 DFU 0483:DF11 separately. Serial disconnect alone does not prove DFU.");
      }
      if (cmd === "status" || cmd === "arm" || cmd === "disarm") {
        if (host.getConnectionStatus() === "connected") {
          await refreshStatus();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendCli(`[error] ${msg}`);
      setUiMessage(msg);
      if (isBootloaderCommand(cmd)) appendCli("[bootloader] Request not verified; do not retry automatically. Check the firmware reply and actual USB DFU device before proceeding.");
    }
  }

  return (
    <div className="panel">
      <h2>CLI</h2>
      <p><strong>PID diagnostics — no motor output:</strong> props removed, USB only. Send <code>pid_diag start</code> for zero rate demand, or <code>pid_diag start rx</code> for live receiver rate demand. Read <code>pid_diag</code> snapshots while gently rotating the board; <code>pid_diag stop</code> ends the session. This is an isolated Acro/rate calculation, not live stabilization or flight arming. No accelerometer calibration is required. Sessions expire after 60 seconds; invalid gyro, receiver loss in RX mode, calibration, motor activity or USB loss invalidates/stops the diagnostic. Do not run the motor commands below during this test.</p>
      <p>Props-off switch test: remove all propellers, connect USB and ESC power, put throttle and AUX1 low, then send <code>bench_switch</code>. AUX1 high runs all four motors at 8% for up to three seconds. AUX1 low stops them. Send <code>bench_stop</code> to cancel. Receiver/USB loss or raised throttle cancels the session; it also expires after 60 seconds. Flight remains disarmed and gyro readiness is not required.</p>
      <p className="muted">
        Allowlisted exact commands: {ALLOWED_CLI_COMMANDS.join(", ")}.
        Patterned get/set also accepted for eRPM / DShot telem / bidir:{" "}
        <code>get erpm_m1</code>…<code>get erpm_m4</code>,{" "}
        <code>get dshot_telem_m1</code>…<code>get dshot_telem_m4</code>,{" "}
        <code>get dshot_bidir</code>, <code>set dshot_bidir on</code> |{" "}
        <code>set dshot_bidir off</code>. Arm / disarm / reboot and bl
        (including bl discard) always ask for confirmation.
      </p>
      <pre className="console" ref={logRef}>
        {cliLines.length === 0 ? (
          <span className="muted">(no I/O yet)</span>
        ) : (
          cliLines.join("\n")
        )}
      </pre>
      <form className="row" onSubmit={onSubmit} style={{ marginTop: "0.75rem" }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="cli-input">Command</label>
          <input
            id="cli-input"
            value={input}
            disabled={!connected}
            autoComplete="off"
            spellCheck={false}
            placeholder="version"
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className="primary"
          disabled={!connected || !input.trim()}
          style={{ alignSelf: "end" }}
        >
          Send
        </button>
      </form>
      {uiMessage && <p className="fail">{uiMessage}</p>}

      {pending && (
        <ConfirmDialog
          open
          title={`Confirm ${pending}`}
          message={isBootloaderCommand(pending) ? `Remove propellers; USB only. Request ST ROM bootloader entry? No automatic save. Unsaved calibration/settings and RAM-only values are lost on reset.${pending === 'bl discard' ? ' DISCARD explicitly accepts losing unsaved configuration; it does not bypass firmware safety checks.' : ' Back up diff all and save supported settings first; dirty configuration will be refused.'} Verify actual STM32 DFU separately; USB disconnect alone is not proof.` : pending === 'bench_switch' ? 'Confirm all propellers are removed. This enables AUX1 to spin all four motors at 8% for up to three seconds. Keep throttle low. This is a bench test, not flight arming.' : `Send the exact CLI command '${pending}'?`}
          confirmLabel={`Send ${pending}`}
          danger={pending === "arm" || pending === "reboot" || pending === "bench_switch" || isBootloaderCommand(pending)}
          onCancel={() => setPending(null)}
          onConfirm={() => void send(pending)}
        />
      )}
    </div>
  );
}
