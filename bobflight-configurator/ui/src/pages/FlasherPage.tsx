/**
 * Firmware Flasher: WebUSB DFU (ST ROM) or mock for CI/demo.
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  validateFirmwareForBoard,
  webUsbUnavailableReason,
  type BoardId,
  type FlashPhase,
  type FlashProgress,
  type Flasher,
  type FlasherKind,
  type ParsedHex,
} from "../flasher";
import { useHost } from "../hooks/useHost";
import { TargetCatalog } from "../targets/TargetCatalog";
import { HexBuilder } from "../flasher/HexBuilder";
import { DiagnosticConsole } from "../flasher/DiagnosticConsole";
import { DiagnosticProfileControls, customProfileProblem } from "../flasher/DiagnosticProfileControls";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function phasePercent(p: FlashProgress): number {
  if (p.phase === "done") return 100;
  if (p.phase === "cancelled" || p.phase === "error" || p.phase === "idle") {
    return p.bytesTotal > 0
      ? Math.min(99, Math.round((100 * p.bytesWritten) / p.bytesTotal))
      : 0;
  }
  if (p.phase === "opening") return 5;
  if (p.phase === "erasing") return 15;
  if (p.phase === "writing") {
    const frac = p.bytesTotal > 0 ? p.bytesWritten / p.bytesTotal : 0;
    return Math.min(80, Math.max(25, 25 + Math.round(55 * frac)));
  }
  if (p.phase === "verifying") {
    const frac = p.bytesTotal > 0 ? p.bytesWritten / p.bytesTotal : 1;
    return Math.min(95, Math.max(80, 80 + Math.round(15 * frac)));
  }
  if (p.phase === "leaving") return 97;
  return 0;
}

function isStDfuVidPid(vendorId: number, productId: number): boolean {
  return vendorId === ST_DFU_VID && productId === ST_DFU_PID;
}

/** Chrome empty picker / NotFoundError guidance (filters stay 0483:DF11 only). */
const DFU_EMPTY_PICKER_HELP =
  "No ST ROM DFU (0483:DF11) found in Chrome. On Windows only, Device Manager: check for STM32 BOOTLOADER (0483:DF11): not COM port. If ST DFU appears in Device Manager but Chrome picker is empty → use Zadig to install WinUSB driver on that interface, then restart Chrome. If only COM port shows → use software CLI 'bl' command or hold BOOT / bridge BOOT pads while plugging USB.";

/** Chrome Access denied on device open (still 0483:DF11 only). */
const DFU_ACCESS_DENIED_HELP =
  "Chrome Access denied opening ST DFU (0483:DF11). Close other STM/DFU software or configurator tabs; on Windows only, verify Zadig driver is set to WinUSB (not libusbK) on STM32 BOOTLOADER; restart Chrome completely; then re-enter DFU.";

function formatDfuUsbError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const name = err instanceof DOMException ? err.name : "";
  const lower = raw.toLowerCase();

  if (lower.includes("device was disconnected") || lower.includes("device disconnected")) {
    return `USB device was disconnected (${raw}).`;
  }

  const accessDenied =
    name === "SecurityError" ||
    lower.includes("access denied") ||
    lower.includes("accessdenied") ||
    lower.includes("failed to open") ||
    lower.includes("unable to claim") ||
    lower.includes("claim interface");
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
    return `No device selected. Cancelling the picker makes no changes. If the list was empty: ${DFU_EMPTY_PICKER_HELP} (${raw})`;
  }
  return raw;
}

const IN_PROGRESS: ReadonlySet<FlashPhase> = new Set([
  "opening",
  "erasing",
  "writing",
  "verifying",
  "leaving",
]);

const MOCK_ONLY_DONE =
  "MOCK ONLY: no firmware written to the board";

export function FlasherPage({ onBusyChange }: { onBusyChange?: (busy: boolean) => void } = {}) {
  const {
    connectionStatus,
    postFlashGate,
    setPostFlashGate,
    clearPostFlashGateAfterReconnect,
  } = useHost();

  const [boardId, setBoardId] = useState<BoardId>("");
  const [customMcu, setCustomMcu] = useState("");
  const [customFlash, setCustomFlash] = useState("");
  const [customHse, setCustomHse] = useState("");
  const [diagnosticAssumptions, setDiagnosticAssumptions] = useState(false);
  const [diagnosticConsoleActive, setDiagnosticConsoleActive] = useState(false);
  /** Demo/mock default OFF: explicit opt-in required. */
  const [useMock, setUseMock] = useState(false);
  const [mockUnderstood, setMockUnderstood] = useState(false);
  const [propsOff, setPropsOff] = useState(false);
  const [backupTaken, setBackupTaken] = useState(false);
  const [boardMatchConfirmed, setBoardMatchConfirmed] = useState(false);
  const [fullChipErase, setFullChipErase] = useState(false);
  const [fullEraseConfirmed, setFullEraseConfirmed] = useState(false);

  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [parsed, setParsed] = useState<ParsedHex | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const fileSeqRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [buildBusy, setBuildBusy] = useState(false);
  const builderRef = useRef(false);

  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [claimedVid, setClaimedVid] = useState<number | null>(null);
  const [claimedPid, setClaimedPid] = useState<number | null>(null);

  const [progress, setProgress] = useState<FlashProgress>({
    phase: "idle",
    bytesWritten: 0,
    bytesTotal: 0,
  });
  const [busy, setBusy] = useState(false);
  const operationRef = useRef(false);
  const pickerRef = useRef(false);
  const previousBoardRef = useRef("");
  const [pickerBusy, setPickerBusy] = useState(false);
  const [verifyingReconnect, setVerifyingReconnect] = useState(false);
  const loadingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [showReconnectHint, setShowReconnectHint] = useState(false);
  const [mockFlashComplete, setMockFlashComplete] = useState(false);
  const [flasher, setFlasher] = useState<Flasher | null>(null);

  const board = useMemo(
    () => BOARD_OPTIONS.find((b) => b.boardId === boardId),
    [boardId],
  );

  const onBuildBusy = useCallback((active: boolean) => {
    builderRef.current = active; setBuildBusy(active);
    if (active) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      fileSeqRef.current++; loadingRef.current = false; setFileLoading(false);
      setParsed(null); setFileName(null); setFileSize(null); setParseError(null);
      setBoardMatchConfirmed(false); setFullEraseConfirmed(false); setShowReconnectHint(false); setMockFlashComplete(false);
      setProgress({phase:"idle",bytesWritten:0,bytesTotal:0});
    }
    onBusyChange?.(active || operationRef.current);
  }, [onBusyChange]);

  const diagnostic = board?.imageProfile === 'f405-usb-diagnostic';
  const customBoard = boardId === 'custom_f405xg_usb';
  const customProblem = customProfileProblem(customBoard,customMcu,customFlash,customHse);
  const onDiagnosticActive = useCallback((active:boolean)=>{
    setDiagnosticConsoleActive(active);onBusyChange?.(active||operationRef.current||builderRef.current);
  },[onBusyChange]);
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
      return "Protocol WebUSB DFU API (createFlasher) not exported yet: mock available in demo mode";
    }
    return null;
  }, [webUsbOk, protocolReady]);

  const kind: FlasherKind = useMock ? "mock" : "webusb-dfu";
  const isLive = kind === "webusb-dfu";
  const demoMode = useMock;

  const stDfuClaimed =
    claimedVid != null &&
    claimedPid != null &&
    isStDfuVidPid(claimedVid, claimedPid);

  useEffect(() => {
    setError(null);
    try {
      const f = createFlasher(useMock ? "mock" : "webusb-dfu");
      setFlasher(f);
    } catch (err) {
      setFlasher(null);
      setError(err instanceof Error ? err.message : String(err));
    }
    setDeviceLabel(null);
    setClaimedVid(null);
    setClaimedPid(null);
    setShowReconnectHint(false);
    setMockFlashComplete(false);
    setProgress({ phase: "idle", bytesWritten: 0, bytesTotal: 0 });
  }, [useMock]);

  useEffect(() => {
    if (!flasher) return;
    return flasher.onProgress((p) => setProgress(p));
  }, [flasher]);

  useEffect(() => {
    if (!demoMode) setMockUnderstood(false);
  }, [demoMode]);

  const validationError = useMemo(
    () => customProblem ?? validateFirmwareForBoard(parsed, boardId, fileName),
    [parsed, boardId, fileName, customProblem],
  );

  const flashing = busy || IN_PROGRESS.has(progress.phase);
  useEffect(() => { setBoardMatchConfirmed(false); setFullEraseConfirmed(false); }, [boardId, parsed, fileName, deviceLabel, useMock, customMcu, customFlash, customHse, diagnosticAssumptions]);
  useEffect(() => {
    setClaimedVid(null); setClaimedPid(null); setDeviceLabel(null);
    setDiagnosticAssumptions(false);
    if (previousBoardRef.current && previousBoardRef.current !== boardId) {
      setPropsOff(false); setBackupTaken(false);
    }
    previousBoardRef.current = boardId;
  }, [boardId, customMcu, customFlash, customHse]);
  useEffect(() => {
    const usb = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & {usb?: EventTarget}).usb;
    if (!usb?.addEventListener) return;
    const disconnected = () => { setClaimedVid(null); setClaimedPid(null); setDeviceLabel(null); setBoardMatchConfirmed(false); setFullEraseConfirmed(false); };
    usb.addEventListener('disconnect', disconnected);
    return () => usb.removeEventListener('disconnect', disconnected);
  }, []);
  useEffect(() => () => { fileSeqRef.current++; }, []);
  useEffect(() => () => { flasher?.cancel(); }, [flasher]);
  useEffect(() => {
    if (!flashing && !buildBusy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [flashing, buildBusy]);
  const cdcConnectedLive = isLive && connectionStatus === "connected";

  const onPickFile = useCallback(
    async (file: File | null, fromBuilder = false) => {
      if (flashing || diagnosticConsoleActive || operationRef.current || (builderRef.current && !fromBuilder)) return;
      const currentSeq = ++fileSeqRef.current;
      setBoardMatchConfirmed(false);
      setFullEraseConfirmed(false);
      setParseError(null);
      setParsed(null);
      setFileName(null);
      setFileSize(null);
      setShowReconnectHint(false);
      setMockFlashComplete(false);
      setProgress({ phase: "idle", bytesWritten: 0, bytesTotal: 0 });

      if (!file) {
        loadingRef.current = false;
        setFileLoading(false);
        return;
      }

      if (file.size > 8 * 1024 * 1024) {
        loadingRef.current = false;
        setFileLoading(false);
        setParseError('Firmware file exceeds the 8 MiB input limit.');
        return;
      }
      loadingRef.current = true;
      setFileName(file.name);
      setFileSize(file.size);
      setFileLoading(true);

      try {
        const text = await file.text();
        if (fileSeqRef.current !== currentSeq) return;
        const hint = mcuHintFromFilename(file.name);
        const hex = parseIntelHex(text, { mcuHint: hint });
        setParsed(hex);
      } catch (err) {
        if (fileSeqRef.current !== currentSeq) return;
        setParseError(err instanceof Error ? err.message : String(err));
      } finally {
        if (fileSeqRef.current === currentSeq) {
          loadingRef.current = false;
          setFileLoading(false);
        }
      }
    },
    [flashing, diagnosticConsoleActive],
  );

  async function onRequestDevice() {
    if (builderRef.current || flashing || diagnosticConsoleActive || pickerRef.current || operationRef.current || !isLive || liveDisabledReason || cdcConnectedLive) return;
    if (!flasher?.requestDevice) {
      setError("Device picker not available on this flasher");
      return;
    }
    pickerRef.current = true;
    setPickerBusy(true);
    setBoardMatchConfirmed(false);
    setFullEraseConfirmed(false);
    setError(null);
    setDeviceLabel(null);
    setClaimedVid(null);
    setClaimedPid(null);
    try {
      const info = await flasher.requestDevice();
      if (!isStDfuVidPid(info.vendorId, info.productId)) {
        setError(
          `Rejected device VID ${info.vendorId.toString(16)} PID ${info.productId.toString(16)}: need ST ROM DFU ${ST_DFU_VID.toString(16)}:${ST_DFU_PID.toString(16)} (0483:DF11)`,
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
      setError(formatDfuUsbError(err));
    } finally {
      pickerRef.current = false;
      setPickerBusy(false);
    }
  }

  async function onFlash() {
    if (builderRef.current || flashing || diagnosticConsoleActive || pickerRef.current || operationRef.current || loadingRef.current) return;
    if (!board || !flasher || !parsed || !propsOff || !backupTaken) return;
    if (fullChipErase && !fullEraseConfirmed) {
      setError("Confirm full chip erase risk and recovery preparation before flashing.");
      return;
    }
    if (diagnostic && !diagnosticAssumptions) return;

    if (validationError) {
      setError(validationError);
      return;
    }

    if (isLive) {
      if (liveDisabledReason) {
        setError(`Live DFU disabled: ${liveDisabledReason}`);
        return;
      }
      if (cdcConnectedLive) {
        setError("Configurator is still connected over CDC. Disconnect CDC before flashing in DFU mode.");
        return;
      }
      if (!stDfuClaimed) {
        setError("No claimed ST DFU device (0483:DF11). Request DFU device before live flash.");
        return;
      }
      if (!boardMatchConfirmed) {
        setError("Confirm target board match and recovery availability before live flash.");
        return;
      }
    } else {
      if (!mockUnderstood) {
        setError("Confirm mock understanding before Demo flash.");
        return;
      }
    }

    operationRef.current = true;
    onBusyChange?.(true);
    setBusy(true);
    setError(null);
    setShowReconnectHint(false);
    setMockFlashComplete(false);

    if (isLive) {
      setPostFlashGate(true, board.boardId);
    }

    try {
      await flasher.flash(parsed, {
        expectedMcu: board.mcu,
        verify: true,
        leave: !diagnostic,
        ...(fullChipErase ? { eraseMode: "full-chip" as const } : {}),
        ...(diagnostic ? { imageProfile: "f405-usb-diagnostic" as const } : {}),
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
      // Conservative recovery gate: DO NOT clear postFlashGate on live flash error!
      setShowReconnectHint(false);
      if (err instanceof DOMException && err.name === "AbortError") {
        setError("Flash cancelled");
      } else {
        setError(formatDfuUsbError(err));
      }
    } finally {
      operationRef.current = false;
      onBusyChange?.(false);
      if (isLive) { setClaimedVid(null); setClaimedPid(null); setDeviceLabel(null); }
      setFullEraseConfirmed(false);
      setBusy(false);
    }
  }

  function onCancel() {
    flasher?.cancel();
  }

  async function onConfirmReconnect() {
    if (verifyingReconnect) return;
    setVerifyingReconnect(true);
    try {
      const verified = await clearPostFlashGateAfterReconnect();
      if (verified) { setShowReconnectHint(false); setError(null); }
      else setError('Reconnect a live board in Connect and verify the expected target and firmware. Configuration remains locked.');
    } finally { setVerifyingReconnect(false); }
  }

  const canFlashLive =
    !!board &&
    !diagnosticConsoleActive &&
    !buildBusy &&
    (!diagnostic || diagnosticAssumptions) &&
    !!flasher &&
    !!parsed &&
    !parseError &&
    !fileLoading &&
    !validationError &&
    propsOff &&
    backupTaken &&
    boardMatchConfirmed &&
    (!fullChipErase || fullEraseConfirmed) &&
    !flashing &&
    !pickerBusy &&
    !cdcConnectedLive &&
    !liveDisabledReason &&
    stDfuClaimed;

  const canFlashMock =
    !!board &&
    !diagnosticConsoleActive &&
    !buildBusy &&
    (!diagnostic || diagnosticAssumptions) &&
    !!flasher &&
    !!parsed &&
    !parseError &&
    !fileLoading &&
    !validationError &&
    propsOff &&
    backupTaken &&
    (!fullChipErase || fullEraseConfirmed) &&
    !flashing &&
    demoMode &&
    mockUnderstood;

  const canFlash = isLive ? canFlashLive : canFlashMock;

  const pct = phasePercent(progress);

  const flashTitle = !propsOff
    ? "Confirm props removed & battery unplugged first"
    : !backupTaken
      ? "Confirm diff all backup taken and recovery method prepared"
      : fullChipErase && !fullEraseConfirmed
        ? "Confirm full chip erase risk and recovery preparation"
        : diagnostic && !diagnosticAssumptions
          ? "Confirm the diagnostic MCU, clock and USB-only assumptions"
          : !boardId
            ? "Select an exact target board"
            : fileLoading
              ? "Loading firmware file…"
              : !parsed
                ? "Select a valid .hex file"
                : validationError
                  ? validationError
                  : isLive && liveDisabledReason
                    ? liveDisabledReason
                    : isLive && cdcConnectedLive
                      ? "Disconnect CDC connection before flashing in DFU"
                      : isLive && !stDfuClaimed
                        ? "Claim ST DFU device 0483:DF11 first"
                        : isLive && !boardMatchConfirmed
                          ? "Confirm exact board target match"
                          : demoMode && !mockUnderstood
                            ? "Confirm demo mock understanding"
                            : "Start flash process";

  return (
    <div className="panel flasher-page">
      <TargetCatalog />
      <div className="flasher-header">
        <h2>Firmware Flasher</h2>
        <span className="muted">{fullChipErase ? "Full main-flash erase" : "Sector erase"} + readback verification</span>
        <span className={`pill ${isLive ? "pill-live" : "pill-mock"}`}>
          {isLive ? (liveDisabledReason ? "live DFU unavailable" : "live WebUSB DFU") : "demo / mock"}
        </span>
      </div>

      <p className="muted">
        Stepwise firmware flashing via ST ROM USB DFU (VID 0x0483 / PID 0xDF11).{" "}
        {fullChipErase
          ? "Full chip erase clears all main flash sectors before programming and verified readback. All existing firmware and saved settings will be erased."
          : "Only sectors touched by the image are erased. Saved settings may persist or reset. Incompatible settings require a fresh install using Full chip erase. Back up first and verify after reconnecting."}
      </p>

      {!FLASH_CAPABILITIES.supportsCliFlash && (
        <p className="muted" style={{ marginTop: "-0.35rem" }}>
          Writing firmware uses DFU, not CLI. The bl command only requests bootloader entry. Alternative command below requires a raw BIN, not the HEX selected here:{" "}
          <code>{FLASH_CAPABILITIES.hostEquivalent}</code>
        </p>
      )}

      {liveDisabledReason && !useMock && (
        <div className="banner-warn" role="status">
          <strong>Live DFU unavailable:</strong> {liveDisabledReason}. You may select
          Demo mode below for UI simulation (no hardware writes).
        </div>
      )}

      {demoMode && (
        <div className="banner-warn" role="alert">
          <strong>DEMO / MOCK MODE: This will NOT reflash your flight controller.</strong>{" "}
          Demo mode performs <em>zero</em> USB writes. Board firmware is unchanged.
        </div>
      )}

      {cdcConnectedLive && (
        <div className="banner-warn" role="status">
          <strong>Disconnect Configurator CDC before flashing in DFU mode.</strong>{" "}
          Configurator is currently connected over CDC. Disconnect CDC and put board into ST ROM DFU mode (0483:DF11) before flashing.
        </div>
      )}

      {/* Stage 1 */}
      <section className="preflight" aria-label="Stage 1: Safety & Backup">
        <h3>Stage 1: Safety, Backup & Recovery Setup</h3>
        <p className="muted" style={{ marginTop: "0.25rem" }}>
          Prepare recovery before proceeding.{" "}
          {fullChipErase
            ? "Full main-flash erase will wipe all internal main flash sectors (firmware and saved settings) before programming and readback verification."
            : "Sector erase only clears sectors touched by the image; settings are not guaranteed to reset or survive."}
        </p>
        <ul className="preflight-list">
          <li>
            <strong>Backup:</strong> If the current firmware is readable, use its configurator to save a <code>diff all</code> backup. If no configuration can be read, acknowledge that it cannot be recovered by this page.
          </li>
          <li className="warn-item">
            <strong>Safety:</strong> Remove propellers, disconnect battery (USB power only), keep craft secured.
          </li>
          <li>
            <strong>Recovery plan:</strong> Ensure you have an independent recovery method. If the software bootloader CLI command fails, locate the physical BOOT button or BOOT pads on your board.
          </li>
        </ul>

        <div className="row" style={{ marginTop: "0.5rem", alignItems: "center" }}>
          <label
            htmlFor="props-off"
            style={{ display: "flex", gap: "0.5rem", color: "#fecaca" }}
          >
            <input
              id="props-off"
              type="checkbox"
              checked={propsOff}
              disabled={flashing || buildBusy || diagnosticConsoleActive}
              onChange={(e) => setPropsOff(e.target.checked)}
            />
            Propellers removed, battery disconnected / craft safe: required
          </label>
        </div>

        <div className="row" style={{ marginTop: "0.35rem", alignItems: "center" }}>
          <label
            htmlFor="backup-taken"
            style={{ display: "flex", gap: "0.5rem", color: "#fde68a" }}
          >
            <input
              id="backup-taken"
              type="checkbox"
              checked={backupTaken}
              disabled={flashing || buildBusy || diagnosticConsoleActive}
              onChange={(e) => setBackupTaken(e.target.checked)}
            />
            Saved any readable configuration (or accept that no backup is available) and confirmed independent recovery: required
          </label>
        </div>

        <div className="row" style={{ marginTop: "0.35rem", alignItems: "center" }}>
          <label
            htmlFor="full-chip-erase"
            style={{ display: "flex", gap: "0.5rem", color: "#e2e8f0" }}
          >
            <input
              id="full-chip-erase"
              type="checkbox"
              checked={fullChipErase}
              disabled={flashing || buildBusy || diagnosticConsoleActive}
              onChange={(e) => {
                setFullChipErase(e.target.checked);
                setFullEraseConfirmed(false);
              }}
            />
            Full chip erase (internal flash)
          </label>
        </div>

        {fullChipErase && (
          <div className="full-erase-details" style={{ marginTop: "0.4rem", marginLeft: "1.5rem" }}>
            <p className="muted" style={{ fontSize: "0.85rem", margin: "0.25rem 0 0.4rem 0" }}>
              Full chip erase targets internal main flash only: erase every sector, verify all flash is blank, then program and read back the HEX. Cancellation or failure cannot restore erased data; recover in DFU with the correct HEX. It does not affect OTP memory, option bytes, or external memory storage.
            </p>
            <div className="row" style={{ alignItems: "center" }}>
              <label
                htmlFor="full-erase-confirmed"
                style={{ display: "flex", gap: "0.5rem", color: "#fde68a" }}
              >
                <input
                  id="full-erase-confirmed"
                  type="checkbox"
                  checked={fullEraseConfirmed}
                  disabled={flashing || buildBusy || diagnosticConsoleActive}
                  onChange={(e) => setFullEraseConfirmed(e.target.checked)}
                />
                All firmware and saved settings will be erased. I have the matching HEX and a verified independent DFU recovery method.
              </label>
            </div>
          </div>
        )}
      </section>

      {/* Stage 2 */}
      <section className="preflight" aria-label="Stage 2: Target Selection" style={{ marginTop: "0.75rem" }}>
        <h3>Stage 2: Select Target Board</h3>
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="board">Target Board</label>
            <select
              id="board"
              value={boardId}
              disabled={flashing || buildBusy || pickerBusy || diagnosticConsoleActive}
              onChange={(e) => setBoardId(e.target.value as BoardId)}
            >
              <option value="" disabled>Select a known board or custom profile</option>
              {BOARD_OPTIONS.map((b) => (
                <option key={b.boardId} value={b.boardId}>
                  {b.boardId === "custom_f405xg_usb" ? "Custom / unknown board (basic bring-up)" : `${b.label} (${b.mcuDisplay}) · ${b.support}${!b.motorOutput ? " · no motor output" : ""}`}
                  {b.primary ? ": primary" : ""}
                </option>
              ))}
            </select>
            <p className="muted" style={{ marginTop: "0.35rem" }}>
              Expected MCU gate: {board && !customProblem ? mcuDisplayName(board.mcu) : "no supported profile selected"}: firmware HEX must match this MCU family.
            </p>
          </div>
        </div>
        {diagnostic && <DiagnosticProfileControls custom={customBoard} mcu={customMcu} flash={customFlash} hse={customHse} confirmed={diagnosticAssumptions} disabled={flashing||buildBusy||pickerBusy||diagnosticConsoleActive} onMcu={setCustomMcu} onFlash={setCustomFlash} onHse={setCustomHse} onConfirm={setDiagnosticAssumptions}/>}
      </section>

      {/* Stage 3 */}
      <section className="preflight" aria-label="Stage 3: Firmware File" style={{ marginTop: "0.75rem" }}>
        <h3>Stage 3: Build or Load Firmware (.hex)</h3>
        <HexBuilder boardId={boardId} customMcu={customMcu} customFlash={customFlash} customHse={customHse}
          disabled={flashing || pickerBusy || fileLoading || diagnosticConsoleActive || cdcConnectedLive || demoMode}
          onBusyChange={onBuildBusy} onLoad={(file) => onPickFile(file, true)} />
        <p className="muted" style={{ marginTop: "0.25rem" }}>
          Build from this local source checkout, or import an existing Intel HEX for your exact target. Building never flashes a controller; filenames alone do not prove compatibility.
        </p>
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <div style={{ flex: 2 }}>
            <label htmlFor="hex-file">Firmware File (.hex)</label>
            <input
              id="hex-file"
              ref={fileInputRef}
              type="file"
              accept=".hex,application/octet-stream,text/plain"
              disabled={flashing || buildBusy || diagnosticConsoleActive}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                void onPickFile(f);
              }}
            />
            {fileLoading && (
              <p className="muted" style={{ marginTop: "0.35rem" }}>
                Parsing firmware file…
              </p>
            )}
            {fileName && !fileLoading && (
              <p className="muted" style={{ marginTop: "0.35rem" }}>
                Selected: <strong>{fileName}</strong>
                {fileSize != null ? ` · ${formatBytes(fileSize)}` : ""}
                {parsed
                  ? ` · image ${formatBytes(parsed.byteLength)} @ 0x${parsed.startAddress.toString(16)}`
                  : ""}
              </p>
            )}
            {parseError && <div className="fail">{parseError}</div>}
            {validationError && !parseError && parsed && (
              <div className="fail" style={{ marginTop: "0.4rem" }}>
                {validationError}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Stage 4 */}
      <section className="preflight" aria-label="Stage 4: DFU Bootloader Setup" style={{ marginTop: "0.75rem" }}>
        <h3>Stage 4: Enter DFU Mode & Disconnect CDC</h3>
        <ul className="preflight-list">
          <li>
            <strong>Software method:</strong> In the Configurator CLI tab, type <code>bl</code> to request ST ROM DFU mode. If dirty settings are refused, review and save them first; no automatic discard is performed. A serial disconnect alone does not prove DFU.
          </li>
          <li>
            <strong>Physical method:</strong> If the FC is unresponsive or software bootloader command is unavailable, use the board manufacturer's documented BOOT procedure or an established SWD recovery route. If BOOT is broken or inaccessible, do not rely on software bl to recover failed firmware startup.
          </li>
          <li>
            <strong>Disconnect CDC:</strong> Ensure the CDC serial connection in Configurator is disconnected before proceeding to claim the DFU device.
          </li>
        </ul>
      </section>

      {/* Stage 5 */}
      <section className="preflight" aria-label="Stage 5: Select DFU Device" style={{ marginTop: "0.75rem" }}>
        <h3>Stage 5: Select & Confirm DFU Device</h3>

        <div className="row" style={{ alignItems: "center" }}>
          <label htmlFor="use-mock-flash" style={{ display: "flex", gap: "0.5rem" }}>
            <input
              id="use-mock-flash"
              type="checkbox"
              checked={demoMode}
              disabled={flashing || buildBusy || pickerBusy || diagnosticConsoleActive}
              onChange={(e) => setUseMock(e.target.checked)}
            />
            Demo mode (mock DFU simulation: no USB write)
          </label>
        </div>

        {demoMode && (
          <div className="row" style={{ alignItems: "center", marginTop: "0.35rem" }}>
            <label
              htmlFor="mock-understood"
              style={{ display: "flex", gap: "0.5rem", color: "#fbbf24" }}
            >
              <input
                id="mock-understood"
                type="checkbox"
                checked={mockUnderstood}
                disabled={flashing || buildBusy || diagnosticConsoleActive}
                onChange={(e) => setMockUnderstood(e.target.checked)}
              />
              I understand this is demo / mock and will not write firmware to hardware: required for demo
            </label>
          </div>
        )}

        {isLive && (
          <div style={{ marginTop: "0.5rem" }}>
            <div className="row" style={{ alignItems: "center" }}>
              <button
                type="button"
                className="ghost"
                disabled={flashing || buildBusy || pickerBusy || diagnosticConsoleActive || cdcConnectedLive || !flasher?.requestDevice || !!liveDisabledReason}
                onClick={() => void onRequestDevice()}
              >
                {pickerBusy ? "Selecting device…" : "Select DFU device…"}
              </button>
              <span className="muted">
                {deviceLabel ??
                  (stDfuClaimed
                    ? "ST DFU selected"
                    : "No DFU device selected (need ST 0483:DF11)")}
              </span>
            </div>

            <p className="muted" style={{ marginTop: "0.4rem", maxWidth: "42rem" }}>
              Note: <strong>0483:DF11</strong> is the generic ST ROM DFU USB bootloader ID shared by all STM32 microcontrollers. It does <em>not</em> identify your specific flight controller model or target board.
            </p>

            <div className="row" style={{ marginTop: "0.5rem", alignItems: "center" }}>
              <label
                htmlFor="board-match-confirmed"
                style={{ display: "flex", gap: "0.5rem", color: "#fde68a" }}
              >
                <input
                  id="board-match-confirmed"
                  type="checkbox"
                  checked={boardMatchConfirmed}
                  disabled={flashing || buildBusy || diagnosticConsoleActive}
                  onChange={(e) => setBoardMatchConfirmed(e.target.checked)}
                />
                I confirm this HEX matches my exact board target (0483:DF11 is generic DFU, not board ID) and I have a recovery method: required for live
              </label>
            </div>
          </div>
        )}
      </section>

      {/* Stage 6 */}
      <section className="preflight" aria-label="Stage 6: Execute Flash" style={{ marginTop: "0.75rem" }}>
        <h3>Stage 6: Execute Flash</h3>

        <div className="row" style={{ marginTop: "0.5rem", alignItems: "center" }}>
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

        <div className="flash-progress" aria-live="polite" style={{ marginTop: "0.75rem" }}>
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
          <div className="banner-warn" role="status" style={{ marginTop: "0.65rem" }}>
            <strong>{MOCK_ONLY_DONE}</strong>
            <br />
            Demo path succeeded in-process simulation only. Your flight controller was <em>not</em> reflashed. Do not treat this as a live hardware flash PASS.
          </div>
        )}

        {error && <div className="fail" style={{ marginTop: "0.65rem" }}>{error}</div>}
      </section>

      {/* Stage 7 */}
      <section className="preflight" aria-label="Stage 7: Reconnect & Verify" style={{ marginTop: "0.75rem" }}>
        {diagnostic ? <>
          <h3>Stage 7: Cold restart &amp; read-only diagnostic check</h3>
          <p>After successful readback verification: unplug USB, remove the BOOT bridge, then reconnect USB. This image needs cold-reset state, not a direct ROM bootloader jump. Keep the board on USB power only.</p>
          <p>Expect the F405 diagnostic banner, then status should report stage=8, error=0 and increasing uptime. This identifies the reference firmware, not the physical board. Normal settings and arming controls remain locked. Use only the diagnostic console below, not normal Connect.</p>
          <DiagnosticConsole disabled={demoMode||flashing||buildBusy||pickerBusy||cdcConnectedLive||!diagnosticAssumptions||!!customProblem} onActiveChange={onDiagnosticActive}/>
        </> : <>
        <h3>Stage 7: Reconnect & Restore Configuration</h3>
        <p className="muted" style={{ marginTop: "0.25rem" }}>
          After readback verification, use Connect to select the real CDC port, not a mock port. Verify target/version, inspect settings, and restore only compatible settings from your <code>diff all</code> backup. Use <code>save</code> for deliberate persistent changes; no automatic restore or save is performed.
        </p>

        {showReconnectHint && progress.phase === "done" && isLive && (
          <div className="banner-info" role="status" style={{ marginTop: "0.5rem" }}>
            <strong>Firmware written and readback verified.</strong> Replug or connect over CDC (Connect tab), Connect reads version/status automatically and checks the expected board. CLI stays locked until live verification succeeds.
            <div className="row" style={{ marginTop: "0.65rem" }}>
              <button
                type="button"
                className="primary"
                disabled={verifyingReconnect || connectionStatus !== "connected" || !postFlashGate}
                onClick={() => void onConfirmReconnect()}
              >
                {!postFlashGate ? "Live reconnect verified" : verifyingReconnect ? "Checking live board…" : "Verify live reconnect"}
              </button>
            </div>
          </div>
        )}
        </>}
      </section>
    </div>
  );
}
