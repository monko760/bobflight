/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useRef, useState } from "react";
import { catalog } from "../targets/catalog";

export interface HexBuilderProps {
  boardId: string;
  customMcu: string;
  customFlash: string;
  customHse: string;
  disabled: boolean;
  onLoad: (file: File) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}

export interface BoardSupportStatus {
  supported: boolean;
  isF405Diagnostic: boolean;
  reason?: string;
}

export function isBoardSupported(
  boardId: string,
  customMcu: string,
  customFlash: string,
  customHse: string
): BoardSupportStatus {
  if (!boardId) {
    return {
      supported: false,
      isF405Diagnostic: false,
      reason: "Select a board to build HEX.",
    };
  }

  if (boardId === "custom_f405xg_usb") {
    const normMcu = customMcu;
    const valid = normMcu === "STM32F405" && customFlash === "1024" && customHse === "8000000";
    if (!valid) {
      return {
        supported: false,
        isF405Diagnostic: true,
        reason:
          "Custom basic build is only supported for STM32F405, 1024 KiB flash, and 8 MHz HSE external crystal.",
      };
    }
    return { supported: true, isF405Diagnostic: true };
  }

  if (boardId === "mltempf4") {
    return { supported: true, isF405Diagnostic: true };
  }

  const board = catalog.boards.find((b) => b.id === boardId);
  if (board) {
    const mcu = catalog.mcus.find((m) => m.id === board.mcu);
    if (["kakute_f7_hdv", "tmotor_f7_v2"].includes(boardId) && board.support !== "host-only" && mcu && mcu.family === "F7" && mcu.status === "implemented") {
      return { supported: true, isF405Diagnostic: false };
    }
    return {
      supported: false,
      isF405Diagnostic: false,
      reason: `Build not supported for target board '${board.display_name || boardId}'.`,
    };
  }

  return {
    supported: false,
    isF405Diagnostic: false,
    reason: `Build not supported for unknown target '${boardId}'.`,
  };
}

function truncateLog(log: string, maxLen = 16384): string {
  if (log.length <= maxLen) return log;
  return `... [log truncated to ${maxLen} characters]\n` + log.slice(log.length - maxLen);
}

async function computeSha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  let subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (!subtle && typeof globalThis !== "undefined" && globalThis.crypto) {
    subtle = globalThis.crypto.subtle;
  }
  if (!subtle) throw new Error("SHA-256 is unavailable. Open the local configurator on http://127.0.0.1:5173.");
  const hashBuffer = await subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function HexBuilder(props: HexBuilderProps) {
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logOutput, setLogOutput] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [buildResult, setBuildResult] = useState<{
    fileName: string;
    sha256: string;
    sourceRevision?: string;
    profile?: string;
    label?: string;
    hexLength: number;
  } | null>(null);

  const runningRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const blobUrlRef = useRef<string | null>(null);
  const selectionRef = useRef({
    boardId: props.boardId,
    customMcu: props.customMcu,
    customFlash: props.customFlash,
    customHse: props.customHse,
  });

  const targetCheck = isBoardSupported(
    props.boardId,
    props.customMcu,
    props.customFlash,
    props.customHse
  );

  useEffect(() => {
    requestRef.current?.abort();
    selectionRef.current = {
      boardId: props.boardId,
      customMcu: props.customMcu,
      customFlash: props.customFlash,
      customHse: props.customHse,
    };

    setBuildResult(null);
    setError(null);
    setLogOutput(null);

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
      setBlobUrl(null);
    }
  }, [props.boardId, props.customMcu, props.customFlash, props.customHse]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  const handleBuildHex = async () => {
    if (runningRef.current || props.disabled) return;

    const currentCheck = isBoardSupported(
      props.boardId,
      props.customMcu,
      props.customFlash,
      props.customHse
    );
    if (!currentCheck.supported) return;

    runningRef.current = true;
    setBuilding(true);
    setError(null);
    setBuildResult(null);
    setLogOutput(null);

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
      setBlobUrl(null);
    }

    const startSelection = {
      boardId: props.boardId,
      customMcu: props.customMcu,
      customFlash: props.customFlash,
      customHse: props.customHse,
    };

    const controller = new AbortController();
    requestRef.current = controller;
    props.onBusyChange(true);

    try {
      // 1. GET /__bobflight_build -> { protocol: 1, token: string }
      let tokenRes: Response;
      try {
        tokenRes = await fetch("/__bobflight_build", {
          method: "GET",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch {
        throw new Error(
          "Local builder unavailable: endpoint unreachable or server not running."
        );
      }

      if (!tokenRes.ok) {
        throw new Error(`Local builder unavailable (HTTP status ${tokenRes.status}).`);
      }

      let tokenData: { protocol?: number; token?: string; error?: string };
      try {
        tokenData = await tokenRes.json();
      } catch {
        throw new Error("Local builder unavailable: invalid JSON from builder endpoint.");
      }

      if (
        tokenData.protocol !== 1 ||
        !tokenData.token ||
        typeof tokenData.token !== "string"
      ) {
        throw new Error("Local builder unavailable: protocol version mismatch or missing token.");
      }

      if (controller.signal.aborted || !mountedRef.current) return;

      // 2. POST /__bobflight_build JSON {boardId, customMcu, customFlash, customHse}
      let buildRes: Response;
      try {
        buildRes = await fetch("/__bobflight_build", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Bobflight-Build-Token": tokenData.token,
          },
          body: JSON.stringify({
            boardId: props.boardId,
            customMcu: props.customMcu,
            customFlash: props.customFlash,
            customHse: props.customHse,
          }),
        });
      } catch {
        throw new Error("Build request failed: network connection interrupted.");
      }

      let buildData: {
        boardId?: string;
        fileName?: string;
        hex?: string;
        sha256?: string;
        sourceRevision?: string;
        profile?: string;
        label?: string;
        log?: string;
        error?: string;
      };
      try {
        buildData = await buildRes.json();
      } catch {
        throw new Error(
          `Build request failed with HTTP ${buildRes.status} (invalid JSON response).`
        );
      }

      if (!buildRes.ok || buildData.error) {
        if (buildData.log) {
          setLogOutput(truncateLog(buildData.log));
        }
        throw new Error(
          buildData.error || `Build process failed (HTTP status ${buildRes.status}).`
        );
      }

      if (!buildData.hex || typeof buildData.hex !== "string") {
        throw new Error("Build response missing HEX image payload.");
      }

      if (!buildData.sha256 || typeof buildData.sha256 !== "string") {
        throw new Error("Build response missing SHA256 checksum string.");
      }

      // Bounded response length check (<= 8 MiB)
      const MAX_HEX_LENGTH = 8 * 1024 * 1024;
      if (buildData.hex.length > MAX_HEX_LENGTH) {
        throw new Error(
          `Build response size (${buildData.hex.length} bytes) exceeds maximum limit (8 MiB).`
        );
      }

      // Verify SHA256 checksum over UTF8 HEX string
      const calculatedSha = await computeSha256(buildData.hex);
      if (calculatedSha.toLowerCase() !== buildData.sha256.toLowerCase()) {
        throw new Error(
          `SHA256 checksum mismatch (expected ${buildData.sha256}, calculated ${calculatedSha}).`
        );
      }

      if (buildData.boardId !== startSelection.boardId ||
          buildData.profile !== (currentCheck.isF405Diagnostic ? "f405-usb-diagnostic" : "main") ||
          typeof buildData.sourceRevision !== "string" || !/^[0-9a-f]{40}$/.test(buildData.sourceRevision) ||
          typeof buildData.fileName !== "string" || !/^[a-zA-Z0-9_.-]+\.hex$/.test(buildData.fileName)) {
        throw new Error("Build response target/profile/provenance does not match this request.");
      }

      // Check if selection changed or unmounted during build
      const isSelectionCurrent =
        selectionRef.current.boardId === startSelection.boardId &&
        selectionRef.current.customMcu === startSelection.customMcu &&
        selectionRef.current.customFlash === startSelection.customFlash &&
        selectionRef.current.customHse === startSelection.customHse;

      if (mountedRef.current && isSelectionCurrent && !controller.signal.aborted) {
        if (buildData.log) {
          setLogOutput(truncateLog(buildData.log));
        }

        const hexBlob = new Blob([buildData.hex], { type: "text/plain;charset=utf-8" });
        const newBlobUrl = URL.createObjectURL(hexBlob);
        blobUrlRef.current = newBlobUrl;
        setBlobUrl(newBlobUrl);

        const fileName = buildData.fileName || `${props.boardId || "firmware"}.hex`;
        setBuildResult({
          fileName,
          sha256: buildData.sha256,
          sourceRevision: buildData.sourceRevision,
          profile: buildData.profile,
          label: buildData.label,
          hexLength: buildData.hex.length,
        });

        const file = new File([hexBlob], fileName, { type: "text/plain" });
        await props.onLoad(file);
      }
    } catch (err: unknown) {
      if (mountedRef.current && !controller.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      runningRef.current = false;
      if (mountedRef.current) {
        setBuilding(false);
      }
      props.onBusyChange(false);
    }
  };

  return (
    <div
      className="hex-builder-container"
      style={{
        marginTop: "1rem",
        padding: "0.75rem 1rem",
        border: "1px solid #334155",
        borderRadius: "6px",
        backgroundColor: "transparent",
        color: "inherit",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn-build-hex"
          onClick={handleBuildHex}
          disabled={props.disabled || building || !targetCheck.supported}
          style={{
            padding: "0.4rem 0.9rem",
            cursor: props.disabled || building || !targetCheck.supported ? "not-allowed" : "pointer",
            fontWeight: "bold",
            borderRadius: "4px",
            border: "1px solid #555",
            background: undefined,
            color: "#fff",
          }}
        >
          {building ? "Building HEX..." : "Build HEX"}
        </button>

        {targetCheck.isF405Diagnostic && targetCheck.supported && (
          <span
            className="hex-builder-label"
            style={{ fontSize: "0.85rem", color: "#e6a23c", fontWeight: "500" }}
          >
            F405 USB diagnostic build profile (diagnostic bring-up only)
          </span>
        )}
      </div>

      <p className="muted">Builds this clean local source checkout using installed ARM tools and Python. F7 also needs CMake and Make. No cloud build or automatic flashing.</p>
      {!targetCheck.supported && targetCheck.reason && (
        <div
          className="hex-builder-warning"
          style={{
            marginTop: "0.5rem",
            fontSize: "0.85rem",
            color: "#ffb74d",
          }}
        >
          {targetCheck.reason}
        </div>
      )}

      {error && (
        <div
          className="hex-builder-error"
          style={{
            marginTop: "0.5rem",
            color: "#ff5252",
            fontSize: "0.85rem",
            backgroundColor: "#2a1515",
            padding: "0.5rem",
            borderRadius: "4px",
            border: "1px solid #5c1d1d",
          }}
        >
          <strong>Build Error:</strong> {error}
        </div>
      )}

      {buildResult && (
        <div
          className="hex-builder-result"
          style={{
            marginTop: "0.5rem",
            fontSize: "0.85rem",
            backgroundColor: "#1b2a1b",
            padding: "0.5rem 0.75rem",
            borderRadius: "4px",
            border: "1px solid #2e4d2e",
          }}
        >
          <div style={{ color: "#66bb6a", fontWeight: "bold", marginBottom: "0.25rem" }}>
            HEX built; transfer checksum verified. Nothing flashed.
          </div>
          <div>
            <strong>File:</strong> {buildResult.fileName} (
            {(buildResult.hexLength / 1024).toFixed(1)} KiB)
          </div>
          {buildResult.label && (
            <div>
              <strong>Label:</strong> {buildResult.label}
            </div>
          )}
          {buildResult.profile && (
            <div>
              <strong>Profile:</strong> {buildResult.profile}
            </div>
          )}
          {buildResult.sourceRevision && (
            <div>
              <strong>Revision:</strong> {buildResult.sourceRevision}
            </div>
          )}
          <div>
            <strong>SHA256:</strong>{" "}
            <code style={{ fontSize: "0.8rem", color: "#a5d6a7" }}>
              {buildResult.sha256}
            </code>
          </div>
          {blobUrl && (
            <div style={{ marginTop: "0.4rem" }}>
              <a
                href={blobUrl}
                download={buildResult.fileName}
                className="btn-download-hex"
                style={{ color: "#64b5f6", textDecoration: "underline" }}
              >
                Download {buildResult.fileName}
              </a>
            </div>
          )}
        </div>
      )}

      {logOutput && (
        <div className="hex-builder-log-container" style={{ marginTop: "0.5rem" }}>
          <label
            style={{
              display: "block",
              fontSize: "0.8rem",
              color: "#aaa",
              marginBottom: "0.2rem",
            }}
          >
            Build Log:
          </label>
          <pre
            className="hex-builder-log"
            style={{
              background: "#0d0d0d",
              color: "#ccc",
              padding: "0.5rem",
              borderRadius: "4px",
              maxHeight: "150px",
              overflowY: "auto",
              fontSize: "0.8rem",
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              border: "1px solid #334155",
              margin: 0,
            }}
          >
            {logOutput}
          </pre>
        </div>
      )}
    </div>
  );
}

export default HexBuilder;
