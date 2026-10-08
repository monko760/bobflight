/**
 * F405 USB Diagnostic Console React Component.
 * Post-flash verification UI with explicit WebSerial connect, Close,
 * fixed buttons (version/status/help), and bounded text output.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from "react";
import {
  ALLOWED_COMMANDS,
  DiagnosticConsoleSession,
  type DiagnosticCommand,
  type MinimalSerialPort,
  type SessionState,
} from "./diagnostic-console-session";

export interface DiagnosticConsoleProps {
  disabled: boolean;
  onActiveChange?: (active: boolean) => void;
  /** Optional override for WebSerial requestPort (useful for testing) */
  requestPortOverride?: () => Promise<MinimalSerialPort>;
  /** Optional pre-created session instance (useful for testing) */
  sessionOverride?: DiagnosticConsoleSession;
}

export function DiagnosticConsole({
  disabled,
  onActiveChange,
  requestPortOverride,
  sessionOverride,
}: DiagnosticConsoleProps) {
  const sessionRef = useRef<DiagnosticConsoleSession | null>(null);

  if (!sessionRef.current) {
    sessionRef.current =
      sessionOverride ||
      new DiagnosticConsoleSession({
        onActiveChange,
        requestPortOverride,
      });
  }

  const [sessionState, setSessionState] = useState<SessionState>(
    sessionRef.current.getState()
  );
  const [output, setOutput] = useState<string>(sessionRef.current.getOutput());
  const [verified, setVerified] = useState<boolean>(sessionRef.current.isVerified());
  const [error, setError] = useState<string | null>(sessionRef.current.getLastError());
  const [commandBusy, setCommandBusy] = useState<boolean>(false);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;

    session.setCallbacks({
      onOutput: (text) => setOutput(text),
      onStateChange: (st) => {
        setSessionState(st);
        setVerified(session.isVerified());
      },
      onError: (err) => setError(err),
      onActiveChange: (act) => onActiveChange?.(act),
      requestPortOverride,
    });
  }, [onActiveChange, requestPortOverride]);

  // If disabled prop flips to true while connected/active, close safely
  useEffect(() => {
    const session = sessionRef.current;
    if (disabled && session && session.isActive()) {
      void session.close();
    }
  }, [disabled]);

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (session) {
        void session.close();
      }
    };
  }, []);

  const handleConnect = async () => {
    if (disabled || sessionState !== "disconnected") return;
    setError(null);
    const session = sessionRef.current;
    if (session) {
      await session.connect();
    }
  };

  const handleClose = async () => {
    const session = sessionRef.current;
    if (session) {
      await session.close();
    }
  };

  const handleCommand = async (cmd: DiagnosticCommand) => {
    if (disabled || !verified || sessionState !== "connected" || commandBusy) return;
    setCommandBusy(true);
    try {
      const session = sessionRef.current;
      if (session) {
        await session.sendCommand(cmd);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setCommandBusy(false);
    }
  };

  const isConnected = sessionState === "connected" && verified;
  const isConnecting =
    sessionState === "selecting" ||
    sessionState === "opening" ||
    sessionState === "verifying";

  return (
    <div
      className="diagnostic-console-container"
      style={{
        marginTop: "1rem",
        padding: "1rem",
        border: "1px solid #444",
        borderRadius: "6px",
        backgroundColor: "#1a1a1a",
        color: "#eee",
        fontFamily: "sans-serif",
      }}
    >
      <h4 style={{ margin: "0 0 0.5rem 0", fontSize: "1.1rem" }}>
        F405 USB Diagnostic Console
      </h4>

      <div className="diagnostic-console-status" style={{ marginBottom: "0.5rem", fontSize: "0.9rem" }}>
        Status: <strong>{sessionState}</strong>
        {verified && (
          <span style={{ color: "#4caf50", marginLeft: "0.5rem", fontWeight: "bold" }}>
            ✓ Identity Verified
          </span>
        )}
      </div>

      {error && (
        <div
          className="diagnostic-console-error"
          style={{
            color: "#ff5252",
            marginBottom: "0.5rem",
            fontSize: "0.85rem",
            backgroundColor: "#2a1515",
            padding: "0.4rem 0.6rem",
            borderRadius: "4px",
            border: "1px solid #5c1d1d",
          }}
        >
          Error: {error}
        </div>
      )}

      <div
        className="diagnostic-console-controls"
        style={{
          display: "flex",
          gap: "0.5rem",
          marginBottom: "0.75rem",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={handleConnect}
          disabled={disabled || sessionState !== "disconnected"}
          className="btn-connect-diagnostic"
          style={{
            padding: "0.4rem 0.8rem",
            cursor: disabled || sessionState !== "disconnected" ? "not-allowed" : "pointer",
          }}
        >
          {isConnecting ? "Connecting..." : "Connect diagnostic port"}
        </button>

        <button
          type="button"
          onClick={handleClose}
          disabled={sessionState === "disconnected"}
          className="btn-close-diagnostic"
          style={{
            padding: "0.4rem 0.8rem",
            cursor: sessionState === "disconnected" ? "not-allowed" : "pointer",
          }}
        >
          Close
        </button>

        {ALLOWED_COMMANDS.map((cmd) => (
          <button
            key={cmd}
            type="button"
            onClick={() => handleCommand(cmd)}
            disabled={disabled || !isConnected || commandBusy}
            className={`btn-command-${cmd}`}
            style={{
              padding: "0.4rem 0.8rem",
              cursor: disabled || !isConnected || commandBusy ? "not-allowed" : "pointer",
            }}
          >
            {cmd}
          </button>
        ))}
      </div>

      <div className="diagnostic-console-output">
        <label
          style={{
            display: "block",
            fontSize: "0.8rem",
            marginBottom: "0.25rem",
            color: "#aaa",
          }}
        >
          Diagnostic Output (raw string, max 16 KiB):
        </label>
        <pre
          style={{
            background: "#0d0d0d",
            color: "#00ff66",
            padding: "0.75rem",
            borderRadius: "4px",
            height: "180px",
            overflowY: "auto",
            fontSize: "0.85rem",
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            border: "1px solid #333",
            margin: 0,
          }}
        >
          {output || "(No diagnostic output received)"}
        </pre>
      </div>
    </div>
  );
}
