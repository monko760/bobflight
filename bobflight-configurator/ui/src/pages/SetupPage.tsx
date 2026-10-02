/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useHost } from "../hooks/useHost";
import {
  LOOP_RATE_OPTIONS,
  LOOP_RATE_OPTION_LABELS,
  LOOP_RATE_SETTING_UNKNOWN,
  isLoopRateOption,
  loopRateSettingView,
  loopRateView,
  parseLoopStatus,
  shouldDisableArm,
} from "../protocol";
import { LoopRatePoller, type LoopRatePollState } from "../setup/loopRatePoller";
import { LoopRateReasonCard } from "../setup/LoopRateReasonCard";
import { GyroHealthCards, GyroHealthNote } from "../setup/GyroHealthCards";
import {
  LOOP_RATE_SETTING_EMPTY,
  LoopTargetWatcher,
  readLoopRateSetting,
  saveLoopRate,
  selectLoopRate,
  type LoopRateSettingState,
} from "../setup/loopRateSetting";

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
    postFlashGate,
  } = useHost();
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [confirmDefaults, setConfirmDefaults] = useState(false);

  const connected = connectionStatus === "connected";
  // Loop-rate readout: read-only `status` every 1 s, local to this section only
  // (never the shared status, never a StoragePanel `blocked`).
  const [loopPoll, setLoopPoll] = useState<LoopRatePollState>({ raw: null, error: "" });
  const loopPoller = useMemo(
    () => new LoopRatePoller(() => host.sendCommand("status"), setLoopPoll),
    [host],
  );
  // Bumped after every action: pauseLoopPoll() disables the poller directly, and
  // busy true->false can batch into one render when the action fails instantly.
  const [loopPollKick, setLoopPollKick] = useState(0);
  useEffect(() => {
    loopPoller.setEnabled(connected && !busy && !postFlashGate);
    if (!connected) loopPoller.reset();
  }, [loopPoller, connected, busy, postFlashGate, loopPollKick]);
  useEffect(() => () => loopPoller.setEnabled(false), [loopPoller]);
  const loop = loopRateView(loopPoll.raw === null ? null : parseLoopStatus(loopPoll.raw));

  /** Stop the loop-rate poll and let an in-flight read finish before an action. */
  async function pauseLoopPoll() {
    loopPoller.setEnabled(false);
    await loopPoller.idle();
  }

  // Loop-rate setting (FW `loop_rate_hz`): read once per connection, written
  // only by the selector, persisted by the existing verified save flow.
  const [loopSetting, setLoopSetting] = useState<LoopRateSettingState>(LOOP_RATE_SETTING_EMPTY);
  const [loopSettingRead, setLoopSettingRead] = useState(false);
  const loopTarget = loopPoll.raw === null ? null : parseLoopStatus(loopPoll.raw).targetHz;
  const loopSelector = loopRateSettingView(loopSetting.get, loopSetting.report, loopTarget);
  const loopSelectorEnabled = connected && !busy && !postFlashGate && loopSelector.supported === true;

  /** Selector actions: busy (poll paused), one CLI command at a time. */
  async function runLoopRateAction(action: () => Promise<LoopRateSettingState>) {
    if (!connected || busy) return;
    setBusy(true);
    try {
      await pauseLoopPoll();
      setLoopSetting(await action());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoopSetting((prev) => ({ ...prev, message: "", error: msg }));
    } finally {
      setLoopSettingRead(true);
      setBusy(false);
      setLoopPollKick((k) => k + 1);
    }
  }
  useEffect(() => {
    if (!connected) {
      setLoopSetting(LOOP_RATE_SETTING_EMPTY);
      setLoopSettingRead(false);
      return;
    }
    if (!loopSettingRead && !busy && !postFlashGate) void runLoopRateAction(() => readLoopRateSetting(host));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, loopSettingRead, busy, postFlashGate, host]);
  // A runtime fallback changes the polled target without any selector action:
  // re-read the report so the reason card never pairs a new target with a
  // stale reason token. Deferred while busy (the effect re-runs when idle).
  const loopTargetWatcher = useMemo(() => new LoopTargetWatcher(), []);
  useEffect(() => {
    if (!connected) {
      loopTargetWatcher.reset();
      return;
    }
    if (busy || postFlashGate) return;
    if (loopTargetWatcher.changed(loopTarget)) setLoopSettingRead(false);
  }, [loopTargetWatcher, connected, loopTarget, busy, postFlashGate]);
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
      await pauseLoopPoll();
      // Re-fetch version + status via existing host APIs (no new commands).
      await pollAfterConnect();
      await refreshStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setActionErr(msg);
    } finally {
      setBusy(false);
      setLoopPollKick((k) => k + 1);
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
      await pauseLoopPoll();
      await host.restoreDefaults();
      setActionMsg("defaults restored");
      setLoopSettingRead(false); // FW `defaults` also resets loop_rate_hz: re-read it
      if (host.getConnectionStatus() === "connected") {
        await refreshStatus();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setActionErr(msg);
    } finally {
      setBusy(false);
      setLoopPollKick((k) => k + 1);
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
              <Fragment key={key}>
                <div className={`status-card${warn ? " status-card-warn" : ""}`}>
                  <div className="k">{key}</div>
                  <div className="v">{val}</div>
                </div>
                {/* Gyro sanity readout next to the gyro rows (live Setup poll). */}
                {key === "gyro_bind" && <GyroHealthCards raw={connected ? loopPoll.raw : null} />}
              </Fragment>
            );
          })}
        </div>
        {connected && <GyroHealthNote raw={loopPoll.raw} />}
      </section>

      {/* Loop rate — frozen status keys loop_target_hz / loop_actual_hz / loop_overruns */}
      <section style={{ marginTop: "1.25rem" }}>
        <h3>Loop rate</h3>
        <p className="muted">
          From CLI <code>status</code>, polled every 1 s while connected and
          paused during actions. Values are shown exactly as the firmware sends
          them; anything missing or unavailable shows unknown.
        </p>
        <div className="status-grid">
          {loop.items.map((item) => (
            <div key={item.key} className="status-card">
              <div className="k">{item.label}</div>
              <div className="v">{connected ? item.value : "unknown"}</div>
            </div>
          ))}
        </div>
        {connected && loop.notice && <p className="muted">{loop.notice}</p>}
        {connected && loopPoll.error && (
          <p className="fail">Loop-rate read failed: {loopPoll.error}</p>
        )}

        <h4 style={{ marginTop: "1rem" }}>Loop-rate setting</h4>
        <p className="muted">
          Firmware setting <code>loop_rate_hz</code>. Saving stores all current
          controller settings (flash-verified). The loop target above is the
          rate actually applied.
        </p>
        <div className="row" style={{ alignItems: "center" }}>
          <label>
            <span className="muted">Selected</span>{" "}
            <select
              aria-label="Loop-rate setting"
              value={loopSelector.selected ?? ""}
              disabled={!loopSelectorEnabled}
              onChange={(e) => {
                const value = e.target.value;
                if (isLoopRateOption(value) && value !== loopSelector.selected)
                  void runLoopRateAction(() => selectLoopRate(host, loopSetting, value));
              }}
            >
              {loopSelector.selected === null && (
                <option value="">{LOOP_RATE_SETTING_UNKNOWN}</option>
              )}
              {LOOP_RATE_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {LOOP_RATE_OPTION_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary"
            disabled={!loopSelectorEnabled}
            onClick={() => void runLoopRateAction(() => saveLoopRate(host, loopSetting))}
          >
            Save loop rate
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!connected || busy || postFlashGate}
            onClick={() => void runLoopRateAction(() => readLoopRateSetting(host))}
          >
            Re-read
          </button>
        </div>
        <div className="status-grid" style={{ marginTop: "0.5rem" }}>
          <div className="status-card">
            <div className="k">Selected (controller RAM)</div>
            <div className="v">{connected ? loopSelector.display : LOOP_RATE_SETTING_UNKNOWN}</div>
          </div>
          <div className="status-card">
            <div className="k">Applied at boot</div>
            <div className="v">{connected ? loopSelector.bootDisplay : LOOP_RATE_SETTING_UNKNOWN}</div>
          </div>
        </div>
        <LoopRateReasonCard report={loopSetting.report} connected={connected} />
        {connected &&
          loopSelector.notices.map((notice) => (
            <p key={notice} className={loopSelector.pendingReboot && notice.startsWith("Pending") ? "banner-warn" : "muted"}>
              {notice}
            </p>
          ))}
        {connected && loopSetting.message && <p className="muted">{loopSetting.message}</p>}
        {connected && loopSetting.error && (
          <p className="fail">Loop-rate setting: {loopSetting.error}</p>
        )}
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
