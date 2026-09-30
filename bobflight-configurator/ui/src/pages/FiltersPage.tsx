import { useCallback, useEffect, useState } from "react";
import { useHost } from "../hooks/useHost";
import { SETTINGS_KEYS, type SettingsKey } from "../protocol";
import { ensureMockConnected } from "../protocol/ensureConnected";
import {
  FILTER_KEYS,
  mockSettingsApi,
  validateFilterHz,
  type FilterKey,
} from "../tuning/mockSettingsApi";
import type { FiltersConfig } from "../tuning/mockTuningStore";
import { browserConfirm, requestRefresh } from "../components/storageRefresh";
import type { GyroNotchIndex } from "../protocol";
import {
  applyNotch,
  draftDirty,
  draftFromRow,
  draftPair,
  draftProblem,
  emptyNotchSnapshot,
  loadedPair,
  notchesSupported,
  notchRows,
  readNotches,
  requestFiltersReload,
  type NotchDraft,
  type NotchSnapshot,
} from "../filters/gyroNotch";
import {
  applyRpmSetting,
  emptyRpmSnapshot,
  readRpm,
  rpmDirtyKeys,
  rpmDraftFromView,
  rpmDraftProblem,
  rpmDraftValues,
  rpmView,
  type RpmDraft,
  type RpmSnapshot,
} from "../filters/rpmFilter";

const FILTER_LABELS: Record<FilterKey, string> = {
  gyro_lpf_hz: "Gyro LPF (Hz)",
  dterm_lpf_hz: "D-term LPF (Hz)",
};

/** Client-side LPF range hint; worded so it cannot be mistaken for an FC `set failed` line. */
export const LPF_RANGE_HINT = "Out of range (10–1000 or 0).";

function emptyFilters(): FiltersConfig {
  return { gyro_lpf_hz: 0, dterm_lpf_hz: 0 };
}

function formatSettingValue(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(8).replace(/\.?0+$/, "");
  return s.length ? s : "0";
}

function mapFiltersFromAll(all: Record<string, string>): FiltersConfig {
  const next = emptyFilters();
  for (const key of FILTER_KEYS) {
    const raw = all[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) next[key] = n;
  }
  return next;
}

/** FALLBACK ONLY — local mockSettingsApi when host settings throw. */
function loadFiltersViaFallback(): FiltersConfig {
  const next = emptyFilters();
  for (const key of FILTER_KEYS) {
    const reply = mockSettingsApi.get(key);
    const idx = reply.indexOf("=");
    if (idx <= 0) {
      throw new Error(reply === "unknown key" ? "unknown key" : reply);
    }
    const n = Number(reply.slice(idx + 1));
    if (!Number.isFinite(n)) throw new Error(`get failed: ${reply}`);
    next[key] = n;
  }
  return next;
}

function settingsErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // The FC's own refusal line is shown verbatim (e.g. "set failed: gyro_notch1_hz must be ...").
  if (/^set failed: /.test(msg)) return msg;
  if (/unknown key/i.test(msg)) return "unknown key";
  if (/set failed/i.test(msg)) return "set failed";
  if (/save failed/i.test(msg)) return "save failed";
  return msg;
}

export function FiltersPage() {
  const { host } = useHost();
  const [values, setValues] = useState<FiltersConfig>(emptyFilters);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadedValues, setLoadedValues] = useState<FiltersConfig>(emptyFilters);
  const [notchSnap, setNotchSnap] = useState<NotchSnapshot>(emptyNotchSnapshot);
  const [drafts, setDrafts] = useState<Record<GyroNotchIndex, NotchDraft>>({
    1: { enabled: false, center: "", cutoff: "" },
    2: { enabled: false, center: "", cutoff: "" },
  });
  const [notchFcLine, setNotchFcLine] = useState<string | null>(null);
  const [rpmSnap, setRpmSnap] = useState<RpmSnapshot>(emptyRpmSnapshot);
  const [rpmDraft, setRpmDraft] = useState<RpmDraft>({ harmonics: "", minHz: "", q: "" });
  const [rpmFcLine, setRpmFcLine] = useState<string | null>(null);

  /** Re-read the RPM filter (`get` x4 + `rpm_filter`); inputs return to what the FC holds. */
  const reloadRpm = useCallback(async (schema: number | null) => {
    const snap = await readRpm(host);
    setRpmSnap(snap);
    setRpmDraft(rpmDraftFromView(rpmView(snap, schema)));
    return snap;
  }, [host]);

  /** Re-read the notch rows from the FC (`get` x4 + `filters` + `storage`). Never optimistic. */
  const reloadNotches = useCallback(async () => {
    const snap = await readNotches(host);
    setNotchSnap(snap);
    const rows = notchRows(snap);
    setDrafts({ 1: draftFromRow(rows[0]), 2: draftFromRow(rows[1]) });
    return snap;
  }, [host]);

  const load = useCallback(async () => {
    setErr(null);
    try {
      await ensureMockConnected(host);
      const all = await host.getAllSettings();
      const mapped = mapFiltersFromAll(all);
      setValues(mapped);
      setLoadedValues(mapped);
      setUsingFallback(false);
      setReady(true);
      const notches = await reloadNotches();
      await reloadRpm(notches.schema);
    } catch (e) {
      try {
        const fb = loadFiltersViaFallback();
        setValues(fb);
        setLoadedValues(fb);
        // No FC behind the fallback: notch rows stay unknown (never 0/off).
        setNotchSnap(emptyNotchSnapshot());
        setRpmSnap(emptyRpmSnapshot());
        setRpmDraft({ harmonics: "", minHz: "", q: "" });
        setUsingFallback(true);
        setReady(true);
        setErr(
          `Protocol settings unavailable (${settingsErrorMessage(e)}); using local mockSettingsApi fallback`,
        );
      } catch (fe) {
        setErr(settingsErrorMessage(fe));
        setReady(false);
      }
    }
  }, [host, reloadNotches, reloadRpm]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateField(key: FilterKey, raw: string) {
    const n = Number(raw);
    setValues((prev) => ({
      ...prev,
      [key]: Number.isFinite(n) ? n : prev[key],
    }));
    setMsg(null);
    setErr(null);
  }

  async function onSave() {
    setErr(null);
    setMsg(null);
    setNotchFcLine(null);
    setRpmFcLine(null);
    for (const key of FILTER_KEYS) {
      if (!validateFilterHz(values[key])) {
        // Client-side check (not an FC reply), so it must not read like FW text.
        setErr(`${FILTER_LABELS[key]}: ${LPF_RANGE_HINT}`);
        return;
      }
    }
    const rows = notchRows(notchSnap);
    const notchChanges = rows.filter((r) => draftDirty(r, drafts[r.index]));
    for (const r of notchChanges) {
      // Client-side hint only; the FC re-checks and its line wins.
      const problem = draftProblem(drafts[r.index]);
      if (problem) {
        setErr(`Notch ${r.index}: ${problem}`);
        return;
      }
    }
    const rpmNow = rpmView(rpmSnap, notchSnap.schema);
    const rpmChanges = rpmDirtyKeys(rpmNow, rpmDraft);
    {
      // Client-side hint only; the FC re-checks and its line wins.
      const problem = rpmDraftProblem(rpmNow, rpmDraft);
      if (problem) {
        setErr(`RPM filter: ${problem}`);
        return;
      }
    }

    if (usingFallback) {
      for (const key of FILTER_KEYS) {
        const reply = mockSettingsApi.set(key, values[key]);
        if (!reply.startsWith("ok ")) {
          setErr(
            reply === "unknown key" || reply === "set failed"
              ? reply
              : "set failed",
          );
          return;
        }
      }
      const saveReply = mockSettingsApi.save();
      if (saveReply !== "saved") {
        setErr(saveReply === "save failed" ? "save failed" : saveReply);
        return;
      }
      setMsg("saved");
      await load();
      return;
    }

    try {
      await ensureMockConnected(host);
      for (const key of FILTER_KEYS) {
        await host.setSetting(
          key as SettingsKey,
          formatSettingValue(values[key]),
        );
      }
      for (const r of notchChanges) {
        const next = draftPair(drafts[r.index]);
        if (!next) continue;
        const res = await applyNotch(host, r.index, loadedPair(r), next);
        if (!res.ok) {
          // Show the FC's refusal exactly, then re-read what the FC holds now.
          setNotchFcLine(res.fcLine);
          await reloadNotches();
          return;
        }
      }
      // RPM filter: each set is followed by `get <key>` and `rpm_filter` (never optimistic).
      let rs = rpmSnap;
      const rpmValues = rpmDraftValues(rpmDraft);
      for (const k of rpmChanges) {
        const n = rpmValues[k];
        if (n === null) continue;
        const res = await applyRpmSetting(host, rs, k, n);
        rs = res.snap;
        setRpmSnap(rs);
        if (!res.ok) {
          // Show the FC's refusal exactly; inputs show what the FC holds now.
          setRpmFcLine(res.fcLine);
          setRpmDraft(rpmDraftFromView(rpmView(rs, notchSnap.schema)));
          await reloadNotches();
          return;
        }
      }
      // Re-read after the sets (no optimistic update) before saving.
      await reloadNotches();
      await host.saveSettings();
      setMsg("saved");
      await load();
    } catch (e) {
      setErr(settingsErrorMessage(e));
    }
  }

  async function onDefaults() {
    setErr(null);
    setMsg(null);
    if (usingFallback) {
      const reply = mockSettingsApi.defaults("filters");
      if (reply !== "defaults restored") {
        setErr(reply);
        return;
      }
      setMsg("defaults restored");
      await load();
      return;
    }

    try {
      await ensureMockConnected(host);
      await host.restoreDefaults();
      setMsg("defaults restored");
      await load();
    } catch (e) {
      setErr(settingsErrorMessage(e));
    }
  }

  const rows = notchRows(notchSnap);
  const supported = notchesSupported(notchSnap);
  const lpfDirty = FILTER_KEYS.some((k) => values[k] !== loadedValues[k]);
  const rpm = rpmView(rpmSnap, notchSnap.schema);
  const rpmDirty = rpmDirtyKeys(rpm, rpmDraft);
  const rpmHint = rpmDirty.length ? rpmDraftProblem(rpm, rpmDraft) : null;
  const pageDirty = lpfDirty || rows.some((r) => draftDirty(r, drafts[r.index])) || rpmDirty.length > 0;

  function updateRpmDraft(patch: Partial<RpmDraft>) {
    setRpmDraft((prev) => ({ ...prev, ...patch }));
    setMsg(null);
    setErr(null);
    setRpmFcLine(null);
  }

  function updateDraft(i: GyroNotchIndex, patch: Partial<NotchDraft>) {
    setDrafts((prev) => ({ ...prev, [i]: { ...prev[i], ...patch } }));
    setMsg(null);
    setErr(null);
    setNotchFcLine(null);
  }

  function onReload() {
    requestFiltersReload({
      pageDirty,
      fcDirty: notchSnap.fcDirty,
      confirm: browserConfirm,
      reload: () => void load(),
      requestRefresh,
    });
  }

  const protocolKeys = FILTER_KEYS.filter((k) =>
    (SETTINGS_KEYS as readonly string[]).includes(k),
  );

  return (
    <div className="panel">
      <h2>Filters</h2>
      <p className="muted">
        Gyro and D-term low-pass, two manual gyro notches (FW schema 8) and the RPM filter (FW schema 9). Protocol{" "}
        <code>get/set/save/defaults</code>. Keys: {protocolKeys.join(", ") || FILTER_KEYS.join(", ")}.
        Range: <code>0</code> = off; else <code>10..1000</code> Hz. Defaults{" "}
        <code>320</code> / <code>53</code>.
      </p>

      {!ready && !err && (
        <p className="muted">Connecting / loading settings…</p>
      )}

      <fieldset className="tuning-axis">
        <legend>Low-pass</legend>
        <div className="tuning-grid">
          {FILTER_KEYS.map((key) => (
            <div key={key} className="tuning-field">
              <label htmlFor={key}>
                {FILTER_LABELS[key]}{" "}
                <span className="muted">({key})</span>
              </label>
              <input
                id={key}
                type="number"
                step="1"
                min={0}
                max={1000}
                value={values[key]}
                onChange={(e) => updateField(key, e.target.value)}
              />
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="tuning-axis" data-testid="gyro-notch">
        <legend>Gyro notch</legend>
        <p className="muted">
          Centre <code>0</code> = off, else <code>20..1000</code> Hz; cutoff (lower -3 dB edge) must be
          above 0 and below the centre. The FC checks the centre against the running loop rate and
          reports the result below; its reply is shown as sent.
          {!supported && " This FC does not report gyro notches (older firmware): rows are read-only and unknown."}
        </p>
        <table className="tuning-grid">
          <thead>
            <tr><th>Notch</th><th>Enabled</th><th>Centre (Hz)</th><th>Cutoff (Hz)</th><th>Active</th><th>Reason</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = drafts[r.index];
              const hint = r.supported && draftDirty(r, d) ? draftProblem(d) : null;
              return (
                <tr key={r.index} data-notch={r.index}>
                  <td>{r.index}</td>
                  <td>
                    {r.supported ? (
                      <input
                        type="checkbox"
                        aria-label={`Notch ${r.index} enabled`}
                        checked={d.enabled}
                        onChange={(e) => updateDraft(r.index, { enabled: e.target.checked })}
                      />
                    ) : (
                      <span className="muted">{r.center}</span>
                    )}
                  </td>
                  <td>
                    <input
                      aria-label={`gyro_notch${r.index}_hz`}
                      type="text"
                      inputMode="decimal"
                      disabled={!r.supported || !d.enabled}
                      value={r.supported ? d.center : r.center}
                      placeholder={r.supported ? "off" : r.center}
                      onChange={(e) => updateDraft(r.index, { center: e.target.value })}
                    />
                  </td>
                  <td>
                    {/* Disabled while the centre is off, but the stored cutoff stays shown and is never cleared. */}
                    <input
                      aria-label={`gyro_notch${r.index}_cutoff_hz`}
                      type="text"
                      inputMode="decimal"
                      disabled={!r.supported || !d.enabled}
                      value={r.supported ? d.cutoff : r.cutoff}
                      onChange={(e) => updateDraft(r.index, { cutoff: e.target.value })}
                    />
                  </td>
                  <td><code>{r.active}</code></td>
                  <td><code>{r.reason}</code>{hint && <span className="fail"> {hint}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {notchFcLine && <p className="fail" data-testid="notch-fc-line">{notchFcLine}</p>}
      </fieldset>

      <fieldset className="tuning-axis" data-testid="rpm-filter">
        <legend>RPM filter</legend>
        <p className="muted">
          Notches that follow each motor from bidirectional DShot eRPM. Harmonics <code>0</code> = off,
          else <code>1..3</code>; minimum <code>50..200</code> Hz; Q <code>1..10</code> (sent ×100 as{" "}
          <code>rpm_filter_q_x100</code>). The FC trims harmonics to the loop rate and reports the state
          and each motor&apos;s tracked frequency below, exactly as sent.
          {!rpm.supported && " This FC does not report the RPM filter (older firmware): values are read-only and unknown."}
        </p>
        <div className="tuning-grid">
          <div className="tuning-field">
            <label htmlFor="rpm_filter_harmonics">Harmonics <span className="muted">(rpm_filter_harmonics)</span></label>
            <input id="rpm_filter_harmonics" aria-label="rpm_filter_harmonics" type="text" inputMode="numeric"
              disabled={!rpm.supported} value={rpm.supported ? rpmDraft.harmonics : rpm.harmonics}
              onChange={(e) => updateRpmDraft({ harmonics: e.target.value })} />
          </div>
          <div className="tuning-field">
            <label htmlFor="rpm_filter_min_hz">Minimum (Hz) <span className="muted">(rpm_filter_min_hz)</span></label>
            <input id="rpm_filter_min_hz" aria-label="rpm_filter_min_hz" type="text" inputMode="numeric"
              disabled={!rpm.supported} value={rpm.supported ? rpmDraft.minHz : rpm.minHz}
              onChange={(e) => updateRpmDraft({ minHz: e.target.value })} />
          </div>
          <div className="tuning-field">
            <label htmlFor="rpm_filter_q">Q <span className="muted">(rpm_filter_q_x100 = Q × 100)</span></label>
            <input id="rpm_filter_q" aria-label="rpm_filter_q" type="text" inputMode="decimal"
              disabled={!rpm.supported} value={rpm.supported ? rpmDraft.q : rpm.q}
              onChange={(e) => updateRpmDraft({ q: e.target.value })} />
          </div>
          <div className="tuning-field">
            <span>Motor poles <span className="muted">(motor_poles, set on the Motors tab)</span></span>
            <code data-rpm="motor_poles">{rpm.motorPoles}</code>
          </div>
        </div>
        <table className="tuning-grid">
          <thead>
            <tr><th>Filter rate (Hz)</th><th>Harmonics running</th><th>Filter active</th><th>Filter reason</th></tr>
          </thead>
          <tbody>
            <tr data-rpm-status="1">
              <td><code>{rpm.sampleHz}</code></td>
              <td><code>{rpm.harmonicsActive}</code></td>
              <td><code>{rpm.active}</code></td>
              <td><code>{rpm.reason}</code></td>
            </tr>
          </tbody>
        </table>
        {rpm.bidirOff && (
          <p className="banner-warn" data-testid="rpm-bidir-off">
            Bidirectional DShot is off, so no motor is tracked. Enable it yourself on the controller (<code>set dshot_bidir on</code>, see the Motors tab); this page never enables it.
          </p>
        )}
        <table className="tuning-grid">
          <thead>
            <tr><th>Motor</th><th>Tracked (Hz)</th></tr>
          </thead>
          <tbody>
            {rpm.motors.map((m) => (
              <tr key={m.motor} data-rpm-motor={m.motor}>
                <td>M{m.motor}</td>
                <td><code>{m.hz}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rpmHint && <p className="fail" data-testid="rpm-hint">{rpmHint}</p>}
        {rpmFcLine && <p className="fail" data-testid="rpm-fc-line">{rpmFcLine}</p>}
      </fieldset>

      <div className="row" style={{ marginTop: "1rem" }}>
        <button type="button" className="primary" onClick={() => void onSave()}>
          Save
        </button>
        <button type="button" className="ghost" onClick={onReload}>
          Reload{pageDirty ? " (discard edits)" : ""}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => void onDefaults()}
        >
          Defaults
        </button>
      </div>
      {msg && <p className="muted">Last reply: {msg}</p>}
      {err && <p className="fail">{err}</p>}
    </div>
  );
}
