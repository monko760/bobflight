/**
 * Firmware Flasher — WebUSB DFU (ST ROM) or mock for CI/demo.
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ST_DFU_PID, ST_DFU_VID } from "@bobflight/protocol";
import {
  BOARD_OPTIONS,
  FLASH_CAPABILITIES,
  createFlasher,
  isWebUsbAvailable,
  mcuDisplayName,
  mcuHintFromFilename,
  parseIntelHex,
  protocolFlasherReady,
  tryBindProtocolFlasher,
  webUsbUnavailableReason,
  type BoardId,
  type FlashPhase,
  type FlashProgress,
  type Flasher,
  type FlasherKind,
  type ParsedHex,
} from "../flasher";
import { useHost } from "../hooks/useHost";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function phasePercent(p: FlashProgress): number {
  if (p.phase === "done") return 100;
  if (p.phase === "idle" || p.phase === "cancelled" || p.phase === "error") {
    return p.bytesTotal > 0
      ? Math.min(100, Math.round((100 * p.bytesWritten) / p.bytesTotal))
      : 0;
  }
  if (p.bytesTotal > 0) {
    return Math.min(99, Math.round((100 * p.bytesWritten) / p.bytesTotal));
  }
  const order: FlashPhase[] = [
    "opening",
    "erasing",
    "writing",
    "verifying",
    "leaving",
    "done",
  ];
  const i = order.indexOf(p.phase);
  if (i < 0) return 0;
  return Math.round(((i + 1) / order.length) * 100);
}

function isStDfuVidPid(vendorId: number, productId: number): boolean {
  return vendorId === ST_DFU_VID && productId === ST_DFU_PID;
}

/** Chrome empty picker / NotFoundError guidance (filters stay 0483:DF11 only). */
const DFU_EMPTY_PICKER_HELP =
  "No ST ROM DFU (0483:DF11) in Chrome. Device Manager: STM32 BOOTLOADER (0483:DF11) — not COM. If ST DFU shows but Chrome is empty → Zadig WinUSB on that interface, restart Chrome. If COM only → hold BOOT while plugging USB.";

/** Chrome Access denied on device open (still 0483:DF11 only). */
const DFU_ACCESS_DENIED_HELP =
  "Chrome Access denied opening ST DFU (0483:DF11). Close Betaflight Configurator and other STM/DFU tools; Zadig must be WinUSB (not libusbK) on STM32 BOOTLOADER; fully restart Chrome; re-enter DFU (hold BOOT while plugging USB).";

function formatDfuUsbError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const name = err instanceof DOMException ? err.name : "";
  const lower = raw.toLowerCase();
  const accessDenied =
    name === "NetworkError" ||
    name === "SecurityError" ||
    name === "InvalidStateError" ||
    lower.includes("access denied") ||
    lower.includes("accessdenied") ||
    lower.includes("failed to open") ||
    lower.includes("unable to claim") ||
    lower.includes("claim interface") ||
    lower.includes("device was disconnected");
  if (accessDenied) {
    return `${DFU_ACCESS_DENIED_HELP} (Chrome: ${raw})`;
  }
  const emptyPicker =
    name === "NotFoundError" ||
    lower.includes("no device selected") ||
    lower.includes("no devices found") ||
    lower.includes("no compatible devices") ||
    lower.includes("not found");
  if (emptyPicker) {
    return `${DFU_EMPTY_PICKER_HELP} (Chrome: ${raw})`;
  }
  return raw;
}

/** @deprecated alias — requestDevice + open share the same formatter */
function formatDfuRequestError(err: unknown): string {
  return formatDfuUsbError(err);
}

const IN_PROGRESS: ReadonlySet<FlashPhase> = new Set([
  "opening",
  "erasing",
  "writing",
  "verifying",
  "leaving",
]);

const MOCK_ONLY_DONE =
  "MOCK ONLY — no firmware written to the board";

export function FlasherPage() {
  const {
    connectionStatus,
    setPostFlashGate,
    clearPostFlashGateAfterReconnect,
  } = useHost();

  const [boardId, setBoardId] = useState<BoardId>("kakute_f7_hdv");
  /** Demo/mock default OFF — explicit opt-in required. */
  const [useMock, setUseMock] = useState(false);
  const [mockUnderstood, setMockUnderstood] = useState(false);
  const [propsOff, setPropsOff] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [parsed, setParsed] = useState<ParsedHex | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [claimedVid, setClaimedVid] = useState<number | null>(null);
  const [claimedPid, setClaimedPid] = useState<number | null>(null);
  const [progress, setProgress] = useState<FlashProgress>({
    phase: "idle",
    bytesWritten: 0,
    bytesTotal: 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReconnectHint, setShowReconnectHint] = useState(false);
  const [mockFlashComplete, setMockFlashComplete] = useState(false);
  const [flasher, setFlasher] = useState<Flasher | null>(null);

  const board = useMemo(
    () => BOARD_OPTIONS.find((b) => b.boardId === boardId) ?? BOARD_OPTIONS[0],
    [boardId],
  );

  const [protocolReady, setProtocolReady] = useState(() => protocolFlasherReady());
  const webUsbOk = useMemo(() => isWebUsbAvailable(), []);

  useEffect(() => {
    let cancelled = false;
    void tryBindProtocolFlasher().then((ok) => {
      if (!cancelled) setProtocolReady(ok || protocolFlasherReady());
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const liveDisabledReason = useMemo(() => {
    if (!webUsbOk) return webUsbUnavailableReason();
    if (!protocolReady) {
      return "Protocol WebUSB DFU API (createFlasher) not exported yet — mock only";
    }
    return null;
  }, [webUsbOk, protocolReady]);

  const kind: FlasherKind = useMock || liveDisabledReason ? "mock" : "webusb-dfu";
  const isLive = kind === "webusb-dfu";
  const demoMode = useMock || !!liveDisabledReason;

  const stDfuClaimed =
    claimedVid != null &&
    claimedPid != null &&
    isStDfuVidPid(claimedVid, claimedPid);

  useEffect(() => {
    try {
      const f = createFlasher(useMock || liveDisabledReason ? "mock" : "webusb-dfu");
      setFlasher(f);
      setError(null);
    } catch (err) {
      setFlasher(createFlasher("mock"));
      setError(err instanceof Error ? err.message : String(err));
      setUseMock(true);
    }
    // Switching flasher backend clears any prior live claim / mock success UI.
    setDeviceLabel(null);
    setClaimedVid(null);
    setClaimedPid(null);
    setShowReconnectHint(false);
    setMockFlashComplete(false);
    setProgress({ phase: "idle", bytesWritten: 0, bytesTotal: 0 });
  }, [useMock, liveDisabledReason]);

  useEffect(() => {
    if (!flasher) return;
    return flasher.onProgress((p) => setProgress(p));
  }, [flasher]);

  // Leaving demo clears the mock-understood ack so re-enabling requires re-confirm.
  useEffect(() => {
    if (!demoMode) setMockUnderstood(false);
  }, [demoMode]);

  const flashing = busy || IN_PROGRESS.has(progress.phase);

  const onPickFile = useCallback(
    async (file: File | null) => {
      setParseError(null);
      setParsed(null);
      setFileName(null);
      setFileSize(null);
      setShowReconnectHint(false);
      setMockFlashComplete(false);
      setProgress({ phase: "idle", bytesWritten: 0, bytesTotal: 0 });
      if (!file) return;

      setFileName(file.name);
      setFileSize(file.size);
      try {
        const text = await file.text();
        const hint = mcuHintFromFilename(file.name);
        const hex = parseIntelHex(text, { mcuHint: hint });
        setParsed(hex);
      } catch (err) {
        setParseError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  async function onRequestDevice() {
    if (!flasher?.requestDevice) {
      setError("Device picker not available on this flasher");
      return;
    }
    setError(null);
    setDeviceLabel(null);
    setClaimedVid(null);
    setClaimedPid(null);
    try {
      const info = await flasher.requestDevice();
      if (!isStDfuVidPid(info.vendorId, info.productId)) {
        setError(
          `Rejected device VID ${info.vendorId.toString(16)} PID ${info.productId.toString(16)} — need ST ROM DFU ${ST_DFU_VID.toString(16)}:${ST_DFU_PID.toString(16)} (0483:DF11)`,
        );
        return;
      }
      const name =
        info.productName ??
        `VID ${info.vendorId.toString(16)} PID ${info.productId.toString(16)}`;
      setClaimedVid(info.vendorId);
      setClaimedPid(info.productId);
      setDeviceLabel(
        `${name}${info.serialNumber ? ` · ${info.serialNumber}` : ""} · 0483:DF11`,
      );
    } catch (err) {
      setError(formatDfuRequestError(err));
    }
  }

  async function onFlash() {
    if (!flasher || !parsed || !propsOff) return;
    if (isLive && !stDfuClaimed) {
      setError(
        "No claimed ST DFU device (0483:DF11). Request DFU device before live flash.",
      );
      return;
    }
    if (demoMode && !mockUnderstood) {
      setError("Confirm mock understanding before Demo flash.");
      return;
    }

    setBusy(true);
    setError(null);
    setShowReconnectHint(false);
    setMockFlashComplete(false);

    // Gate only for live flash — mock must never unlock as if hardware was written.
    if (isLive) {
      setPostFlashGate(true);
    }

    try {
      await flasher.flash(parsed, {
        expectedMcu: board.mcu,
        verify: true,
        leave: true,
      });
      if (isLive) {
        setShowReconnectHint(true);
      } else {
        setMockFlashComplete(true);
        setProgress((prev) => ({
          ...prev,
          phase: "done",
          message: MOCK_ONLY_DONE,
        }));
      }
    } catch (err) {
      if (isLive) {
        // Do not leave false success / unlock as if flashed.
        setPostFlashGate(false);
        setShowReconnectHint(false);
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        setError("Flash cancelled");
      } else {
        setError(formatDfuUsbError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function onCancel() {
    flasher?.cancel();
    setBusy(false);
  }

  function onConfirmReconnect() {
    clearPostFlashGateAfterReconnect();
    setShowReconnectHint(false);
  }

  const canFlashLive =
    !!flasher &&
    !!parsed &&
    !parseError &&
    propsOff &&
    !flashing &&
    !liveDisabledReason &&
    stDfuClaimed;

  const canFlashMock =
    !!flasher &&
    !!parsed &&
    !parseError &&
    propsOff &&
    !flashing &&
    demoMode &&
    mockUnderstood;

  const canFlash = isLive ? canFlashLive : canFlashMock;

  const pct = phasePercent(progress);
  const cdcConnectedLive =
    isLive && connectionStatus === "connected";

  const flashTitle = !propsOff
    ? "Confirm props-off first"
    : !parsed
      ? "Select a .hex file"
      : isLive && !stDfuClaimed
        ? "Claim ST DFU device 0483:DF11 first"
        : demoMode && !mockUnderstood
          ? "Confirm mock / will not write firmware"
          : liveDisabledReason && !useMock
            ? liveDisabledReason
            : "Start flash";

  return (
    <div className="panel flasher-page">
      <div className="flasher-header">
        <h2>Firmware Flasher</h2>
        <span className="muted">Sector erase + readback verification</span>
        <span className={`pill ${isLive ? "pill-live" : "pill-mock"}`}>
          {isLive ? "live WebUSB DFU" : "mock"}
        </span>
      </div>

      <p className="muted">
        Flash BobFlight via ST ROM USB DFU (VID 0x0483 / PID 0xDF11). This is{" "}
        <strong>not</strong> the Configurator CDC CLI link — enter the bootloader
        (DFU), flash, then reconnect over CDC for version/status.
      </p>

      {!FLASH_CAPABILITIES.supportsCliFlash && (
        <p className="muted" style={{ marginTop: "-0.35rem" }}>
          CLI flash is permanently disabled (FW lock). Host equiv:{" "}
          <code>{FLASH_CAPABILITIES.hostEquivalent}</code>
        </p>
      )}

      {liveDisabledReason && (
        <div className="banner-warn" role="status">
          <strong>Live DFU unavailable:</strong> {liveDisabledReason}. Mock
          flash is available for UI/CI — it does <em>not</em> write hardware.
        </div>
      )}

      {demoMode && (
        <div className="banner-warn" role="alert">
          <strong>This will NOT reflash your Kakute.</strong> Demo/mock path
          performs <em>zero</em> USB writes — board firmware is unchanged.
        </div>
      )}

      {cdcConnectedLive && (
        <div className="banner-warn" role="status">
          <strong>Leave CDC / put board in ST ROM DFU (BOOT) before live flash.</strong>{" "}
          Configurator is still connected over CDC — disconnect and enter DFU
          (0483:DF11) before flashing.
        </div>
      )}

      <section className="preflight" aria-label="Preflight">
        <h3>Preflight</h3>
        <ul className="preflight-list">
          <li>
            <strong>Board / target:</strong> {board.label} · board_id{" "}
            <code>{board.boardId}</code> · MCU {board.mcuDisplay} (
            {board.mcu})
          </li>
          <li>
            <strong>DFU vs CDC:</strong> flashing needs DFU bootloader mode.
            Configurator Connect uses CDC CLI after reboot/leave.
          </li>
          <li className="warn-item">
            <strong>Safety:</strong> remove props, disconnect battery / use USB
            power only, keep the craft secured.
          </li>
          <li className="muted">
            Kakute F745 samples under{" "}
            <code>firmware/kakute_f7_hdv/</code>: CDC build is{" "}
            <code>bobflight.hex</code> when present; diagnostic{" "}
            <code>bobflight-prove-reset.hex</code> is blink-only (no COM) —
            do not treat it as a CDC sample.
          </li>
        </ul>
      </section>

      <div className="row" style={{ marginTop: "0.75rem" }}>
        <div>
          <label htmlFor="board">Board</label>
          <select
            id="board"
            value={boardId}
            disabled={flashing}
            onChange={(e) => setBoardId(e.target.value as BoardId)}
          >
            {BOARD_OPTIONS.map((b) => (
              <option key={b.boardId} value={b.boardId}>
                {b.label} ({b.mcuDisplay})
                {b.primary ? " — primary" : ""}
              </option>
            ))}
          </select>
          <p className="muted" style={{ marginTop: "0.35rem" }}>
            expectedMcu gate: {mcuDisplayName(board.mcu)} · hex must match this
            MCU family
          </p>
        </div>
      </div>

      <div className="row" style={{ alignItems: "center" }}>
        <label htmlFor="use-mock-flash" style={{ display: "flex", gap: "0.5rem" }}>
          <input
            id="use-mock-flash"
            type="checkbox"
            checked={demoMode}
            disabled={flashing || !!liveDisabledReason}
            onChange={(e) => setUseMock(e.target.checked)}
          />
          Demo mode (mock DFU — no USB write)
        </label>
      </div>

      {demoMode && (
        <div className="row" style={{ alignItems: "center" }}>
          <label
            htmlFor="mock-understood"
            style={{ display: "flex", gap: "0.5rem", color: "#fbbf24" }}
          >
            <input
              id="mock-understood"
              type="checkbox"
              checked={mockUnderstood}
              disabled={flashing}
              onChange={(e) => setMockUnderstood(e.target.checked)}
            />
            I understand this is mock / will not write firmware
          </label>
        </div>
      )}

      <div className="row" style={{ alignItems: "center" }}>
        <label
          htmlFor="props-off"
          style={{ display: "flex", gap: "0.5rem", color: "#fecaca" }}
        >
          <input
            id="props-off"
            type="checkbox"
            checked={propsOff}
            disabled={flashing}
            onChange={(e) => setPropsOff(e.target.checked)}
          />
          Props removed / craft safe — required before Flash
        </label>
      </div>

      <div className="row" style={{ marginTop: "0.75rem" }}>
        <div style={{ flex: 2 }}>
          <label htmlFor="hex-file">Firmware (.hex)</label>
          <input
            id="hex-file"
            type="file"
            accept=".hex,application/octet-stream,text/plain"
            disabled={flashing}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              void onPickFile(f);
            }}
          />
          {fileName && (
            <p className="muted" style={{ marginTop: "0.35rem" }}>
              Selected: <strong>{fileName}</strong>
              {fileSize != null ? ` · ${formatBytes(fileSize)}` : ""}
              {parsed
                ? ` · image ${formatBytes(parsed.byteLength)} @ 0x${parsed.startAddress.toString(16)}`
                : ""}
            </p>
          )}
          {parseError && <div className="fail">{parseError}</div>}
        </div>
      </div>

      {isLive && (
        <div style={{ marginTop: "0.5rem" }}>
          <div className="row">
            <button
              type="button"
              className="ghost"
              disabled={flashing || !flasher?.requestDevice}
              onClick={() => void onRequestDevice()}
            >
              Request DFU device…
            </button>
            <span className="muted">
              {deviceLabel ??
                (stDfuClaimed
                  ? "ST DFU claimed"
                  : "No DFU device claimed (need ST 0483:DF11)")}
            </span>
          </div>
          <p className="muted" style={{ marginTop: "0.4rem", maxWidth: "42rem" }}>
            Picker filters <strong>0483:DF11</strong> only. FW recipe if Chrome
            is empty: Device Manager <strong>STM32 BOOTLOADER</strong> (not
            COM); Zadig WinUSB on that interface + restart Chrome; if COM only
            → hold BOOT while plugging USB.
          </p>
        </div>
      )}

      <div className="row" style={{ marginTop: "0.85rem", alignItems: "center" }}>
        <button
          type="button"
          className="primary primary-lg"
          disabled={!canFlash}
          title={flashTitle}
          onClick={() => void onFlash()}
        >
          {flashing ? "Flashing…" : "Flash"}
        </button>
        {flashing && (
          <button type="button" className="danger" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>

      <div className="flash-progress" aria-live="polite">
        <div className="flash-progress-meta">
          <span className="flash-stage">Stage: {progress.phase}</span>
          <span className="muted">{pct}%</span>
        </div>
        <div
          className="flash-progress-bar"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`flash-progress-fill phase-${progress.phase}${
              mockFlashComplete || (demoMode && progress.phase === "done")
                ? " phase-mock-done"
                : ""
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {progress.message && (
          <p className="muted" style={{ marginTop: "0.4rem" }}>
            {progress.message}
          </p>
        )}
      </div>

      {(mockFlashComplete || (demoMode && progress.phase === "done")) && (
        <div className="banner-warn" role="status">
          <strong>{MOCK_ONLY_DONE}</strong>
          <br />
          Demo path succeeded in-process only. Your Kakute / flight controller
          was <em>not</em> reflashed. Do not treat this as a live flash PASS.
        </div>
      )}

      {showReconnectHint && progress.phase === "done" && isLive && (
        <div className="banner-info" role="status">
          <strong>Firmware written and readback verified.</strong> Replug / reconnect over CDC
          (Connect tab), run version/status, then confirm below to unlock
          Rates / PID / CLI / Status.
          <div className="row" style={{ marginTop: "0.65rem" }}>
            <button
              type="button"
              className="primary"
              onClick={onConfirmReconnect}
            >
              I reconnected — unlock config tabs
            </button>
          </div>
        </div>
      )}

      {error && <div className="fail">{error}</div>}
    </div>
  );
}
