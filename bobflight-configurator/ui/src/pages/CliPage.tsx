import { FormEvent, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useHost } from "../hooks/useHost";
import {
  ALLOWED_CLI_COMMANDS,
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

  function parseCommand(raw: string): CliCommand | null {
    const verb = raw.trim().toLowerCase().split(/\s+/)[0] ?? "";
    if ((verb === 'bench_switch' || verb === 'bench_stop') && raw.trim() !== verb) return null;
    if ((ALLOWED_CLI_COMMANDS as readonly string[]).includes(verb)) {
      return verb as CliCommand;
    }
    return null;
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setUiMessage(null);
    if (!connected) {
      setUiMessage("Not connected.");
      return;
    }
    const cmd = parseCommand(input);
    if (!cmd) {
      setUiMessage(
        `Rejected: only exact commands allowed (${ALLOWED_CLI_COMMANDS.join(", ")}).`,
      );
      return;
    }
    if (cmd === "arm" || cmd === "disarm" || cmd === "reboot" || cmd === "bench_switch") {
      setPending(cmd);
      return;
    }
    void send(cmd);
  }

  async function send(cmd: CliCommand) {
    setPending(null);
    setInput("");
    try {
      await host.sendCommand(cmd);
      if (cmd === "status" || cmd === "arm" || cmd === "disarm") {
        if (host.getConnectionStatus() === "connected") {
          await refreshStatus();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendCli(`[error] ${msg}`);
      setUiMessage(msg);
    }
  }

  return (
    <div className="panel">
      <h2>CLI</h2>
      <p>Props-off switch test: remove all propellers, connect USB and ESC power, put throttle and AUX1 low, then send <code>bench_switch</code>. AUX1 high runs all four motors at 8% for up to three seconds. AUX1 low stops them. Send <code>bench_stop</code> to cancel. Receiver/USB loss or raised throttle cancels the session; it also expires after 60 seconds. Flight remains disarmed and gyro readiness is not required.</p>
      <p className="muted">
        Exact commands only: {ALLOWED_CLI_COMMANDS.join(", ")}. Arm / disarm /
        reboot always ask for confirmation.
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
          message={pending === 'bench_switch' ? 'Confirm all propellers are removed. This enables AUX1 to spin all four motors at 8% for up to three seconds. Keep throttle low. This is a bench test, not flight arming.' : `Send the exact CLI command '${pending}'?`}
          confirmLabel={`Send ${pending}`}
          danger={pending === "arm" || pending === "reboot" || pending === "bench_switch"}
          onCancel={() => setPending(null)}
          onConfirm={() => void send(pending)}
        />
      )}
    </div>
  );
}
