/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Per-tab Defaults button + confirm dialog (D1). PID -> `defaults pid`,
 * Rates -> `defaults rates`, Filters -> `defaults filters`. The dialog lists
 * this tab's keys with the values the FC reports right now, what is NOT
 * touched, and that nothing is saved until Save. After the run it shows the
 * FC's `defaults_key` lines verbatim, re-reads the tab and marks storage
 * unsaved; an incomplete reply is "Defaults result unknown, re-read".
 */
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { DEFAULTS_GROUP_KEYS, DEFAULTS_NOT_TOUCHED, type BobFlightHost, type DefaultsGroup } from "../protocol";
import {
  DEFAULTS_BUSY_TEXT,
  DEFAULTS_GROUP_LABEL,
  DEFAULTS_NO_HOST_TEXT,
  DEFAULTS_RESULT_UNKNOWN,
  DEFAULTS_UNSAVED_TEXT,
  DEFAULTS_MAYBE_UNSAVED_TEXT,
  DEFAULTS_CLEAN_TEXT,
  readStorageDirty,
  DEFAULTS_UNSUPPORTED_TEXT,
  readGroupValues,
  runGroupDefaults,
  type CurrentValues,
  type DefaultsOutcome,
} from "../tuning/scopedDefaults";

export interface ScopedDefaultsProps {
  host: BobFlightHost;
  group: DefaultsGroup;
  /** Re-read this tab's values from the FC (called after a run that may have changed them). */
  onReread: () => Promise<unknown> | void;
  /** Bumped by the page after a verified Save: clears the "not saved" note. */
  savedRevision?: number;
  /** The page holds edits that the re-read will replace. */
  pageDirty?: boolean;
  disabled?: boolean;
  /** Local demo fallback (no FC): resets demo memory only. */
  localFallback?: () => Promise<void> | void;
}

type Phase = "idle" | "reading" | "confirm" | "running";

export function ScopedDefaults({ host, group, onReread, savedRevision = 0, pageDirty = false, disabled = false, localFallback }: ScopedDefaultsProps) {
  const label = DEFAULTS_GROUP_LABEL[group];
  const keys = DEFAULTS_GROUP_KEYS[group];
  const [phase, setPhase] = useState<Phase>("idle");
  const [current, setCurrent] = useState<CurrentValues>({});
  const [outcome, setOutcome] = useState<DefaultsOutcome | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** After a reset: "yes"/"clean" per the FC's `storage` dirty flag; "maybe": result unknown or storage unreadable. */
  const [unsaved, setUnsaved] = useState<"no" | "yes" | "clean" | "maybe">("no");
  const alive = useRef(true);
  /** Aborted on unmount and on Cancel: drops this tab's dialog reads / `defaults <group>` still queued in the CommandGate. */
  const life = useRef<AbortController | null>(null);
  const fresh = () => { life.current?.abort(); const ac = new AbortController(); life.current = ac; return ac.signal; };
  useEffect(() => () => { alive.current = false; life.current?.abort(); }, []);
  useEffect(() => { setUnsaved("no"); }, [savedRevision]);

  async function open() {
    if (phase !== "idle") return;
    setOutcome(null);
    setNotice(null);
    if (localFallback) { setCurrent({}); setPhase("confirm"); return; }
    setPhase("reading");
    const r = await readGroupValues(host, group, fresh());
    if (!alive.current) return;
    if (r.kind === "busy") { setOutcome({ kind: "busy", detail: r.detail }); setPhase("idle"); return; }
    setCurrent(r.values);
    setPhase("confirm");
  }

  /** One run per confirm: a second click/Enter before React re-renders must not send `defaults` twice. */
  const runningRef = useRef(false);
  async function confirm() {
    if (runningRef.current) return;
    runningRef.current = true;
    try { await runConfirmed(); } finally { runningRef.current = false; }
  }

  async function runConfirmed() {
    setPhase("running");
    if (localFallback) {
      await localFallback();
      if (!alive.current) return;
      setNotice("Local demo memory only: no controller was changed.");
      setPhase("idle");
      return;
    }
    const r = await runGroupDefaults(host, group, fresh());
    if (!alive.current) return;
    setOutcome(r);
    if (r.kind === "ok" || r.kind === "unknown") {
      try { await onReread(); } catch { /* the page shows its own read error */ }
      const dirty = alive.current ? await readStorageDirty(host) : null;
      if (!alive.current) return;
      setUnsaved(r.kind === "ok" && dirty !== null ? (dirty ? "yes" : "clean") : "maybe");
    }
    if (alive.current) setPhase("idle");
  }

  const busy = phase !== "idle";
  return (
    <>
      <button type="button" className="ghost" disabled={disabled || busy} onClick={() => void open()}>
        {phase === "reading" ? "Reading current values…" : phase === "running" ? "Restoring defaults…" : "Defaults…"}
      </button>
      <div data-testid="defaults-result">
        {outcome?.kind === "ok" && (
          <div>
            <p className="muted">{label} defaults restored on the controller ({outcome.count} settings). FC reply:</p>
            <pre data-testid="defaults-key-lines">{outcome.keyLines.join("\n")}</pre>
          </div>
        )}
        {outcome?.kind === "error" && <p className="fail" role="alert" data-testid="defaults-fc-line">{outcome.line}</p>}
        {outcome?.kind === "unsupported" && (
          <div className="fail" role="alert">
            <p data-testid="defaults-fc-line">{outcome.line}</p>
            <p>{DEFAULTS_UNSUPPORTED_TEXT}</p>
          </div>
        )}
        {outcome?.kind === "unknown" && (
          <div className="fail" role="alert" data-testid="defaults-unknown">
            <p><strong>{DEFAULTS_RESULT_UNKNOWN}</strong></p>
            <p>The controller may or may not have reset these settings. The values below were re-read from the controller.</p>
            <p className="muted" data-testid="defaults-unknown-detail">Detail: {outcome.detail}</p>
            {outcome.keyLines.length > 0 && <pre data-testid="defaults-key-lines">{outcome.keyLines.join("\n")}</pre>}
          </div>
        )}
        {outcome?.kind === "busy" && (
          <div className="fail" role="alert">
            <p>{DEFAULTS_BUSY_TEXT}</p>
            <p className="muted">Detail: {outcome.detail}</p>
          </div>
        )}
        {outcome?.kind === "no-host" && <p className="fail" role="alert">{DEFAULTS_NO_HOST_TEXT}</p>}
        {notice && <p className="muted">{notice}</p>}
        {unsaved !== "no" && <p className={unsaved === "clean" ? "muted" : "banner-warn"} data-testid="defaults-unsaved">{unsaved === "yes" ? DEFAULTS_UNSAVED_TEXT : unsaved === "clean" ? DEFAULTS_CLEAN_TEXT : DEFAULTS_MAYBE_UNSAVED_TEXT}</p>}
      </div>
      {phase === "confirm" && (
        <ConfirmDialog
          open
          title={`Restore ${label} defaults?`}
          message={localFallback
            ? `Resets these ${keys.length} ${label} settings in local demo memory (no controller is connected):`
            : `Sends "defaults ${group}". The controller resets these ${keys.length} ${label} settings to firmware defaults:`}
          confirmLabel={`Restore ${label} defaults`}
          danger
          onCancel={() => { life.current?.abort(); setPhase("idle"); }}
          onConfirm={() => void confirm()}
        >
          <table data-testid="defaults-confirm-keys">
            <thead><tr><th>Setting</th><th>Current value</th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k} data-key={k}><td><code>{k}</code></td><td><code>{localFallback ? "demo" : (current[k] ?? "unknown")}</code></td></tr>
              ))}
            </tbody>
          </table>
          <p data-testid="defaults-not-touched">
            Not touched: {DEFAULTS_NOT_TOUCHED.join("; ")}.
          </p>
          <p data-testid="defaults-not-saved"><strong>Nothing is saved until you press Save.</strong> Until then the defaults live in the controller's RAM only; a reboot without Save brings back the saved values.</p>
          {pageDirty && <p className="banner-warn">Your unsaved edits on this tab will be replaced by what the controller reports after the reset.</p>}
        </ConfirmDialog>
      )}
    </>
  );
}
