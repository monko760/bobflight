import { useCallback, useEffect, useRef, useState } from "react";
import { useHost } from "../hooks/useHost";
import { canSaveStorage, SETTINGS_KEYS, validateSettingValue, type SettingsKey, type StorageSnapshot } from "../protocol";
import { ensureMockConnected } from "../protocol/ensureConnected";
import { isGateNotSent } from "../protocol/commandGate";
import { mockSettingsApi, PID_KEYS, type PidKey } from "../tuning/mockSettingsApi";
import type { PidConfig } from "../tuning/mockTuningStore";
import { ScopedDefaults } from "../components/ScopedDefaults";
import { AccelCalSavedNote } from "../components/AccelCalSavedNote";
import { retryWhileGateBusy } from "../tuning/scopedDefaults";
import {
  midSaveFailure,
  numberFromInput,
  pidDraftValid,
  storageSnapshotFromRaw,
  withMidSave,
} from "../tuning/saveHonesty";

const ROLL_KEYS: PidKey[] = ["pid_roll_p", "pid_roll_i", "pid_roll_d"];
const PITCH_KEYS: PidKey[] = ["pid_pitch_p", "pid_pitch_i", "pid_pitch_d"];
const YAW_KEYS: PidKey[] = ["pid_yaw_p", "pid_yaw_i", "pid_yaw_d"];

function emptyPid(): PidConfig {
  return { pid_roll_p: 0, pid_roll_i: 0, pid_roll_d: 0, pid_pitch_p: 0, pid_pitch_i: 0, pid_pitch_d: 0, pid_yaw_p: 0, pid_yaw_i: 0, pid_yaw_d: 0, min_throttle: 0.05, airmode: 0 };
}

function formatSettingValue(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(8).replace(/\.?0+$/, "");
  return s.length ? s : "0";
}

function mapPidFromAll(all: Record<string, string>): PidConfig {
  const next = emptyPid();
  for (const key of PID_KEYS) {
    const raw = all[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) next[key] = n;
  }
  return next;
}

function loadPidViaFallback(): PidConfig {
  const next = emptyPid();
  for (const key of PID_KEYS) {
    const reply = mockSettingsApi.get(key);
    const idx = reply.indexOf("=");
    if (idx <= 0) throw new Error(reply === "unknown key" ? "unknown key" : reply);
    const n = Number(reply.slice(idx + 1));
    if (!Number.isFinite(n)) throw new Error(`get failed: ${reply}`);
    next[key] = n;
  }
  return next;
}

function settingsErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/unknown key/i.test(msg)) return "unknown key";
  if (/set failed/i.test(msg)) return "set failed";
  if (/save failed/i.test(msg)) return "save failed";
  return msg;
}

function pidDirty(values: PidConfig, loaded: PidConfig | null): boolean {
  return !!loaded && PID_KEYS.some((k) => values[k] !== loaded[k]);
}

function AxisGroup({ title, keys, values, ready, onChange }: {
  title: string;
  keys: readonly PidKey[];
  values: PidConfig;
  ready: boolean;
  onChange: (key: PidKey, raw: string) => void;
}) {
  return (
    <fieldset className="tuning-axis">
      <legend>{title}</legend>
      <div className="tuning-grid">
        {keys.map((key) => {
          const invalid = ready && !validateSettingValue(key, values[key]);
          return (
            <div key={key} className="tuning-field">
              <label htmlFor={key}>{key}</label>
              <input
                id={key}
                type="number"
                step="0.00001"
                value={Number.isFinite(values[key]) ? values[key] : ""}
                aria-invalid={invalid ? true : undefined}
                onChange={(e) => onChange(key, e.target.value)}
              />
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

export function PidPage() {
  const { host, connectionStatus, postFlashGate } = useHost();
  const [values, setValues] = useState<PidConfig>(emptyPid);
  const [loaded, setLoaded] = useState<PidConfig | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedRev, setSavedRev] = useState(0);
  /** A controller read failed: shown with "Read again"; Defaults and Save stay disabled until a real read succeeds (never the demo memory). */
  const [readErr, setReadErr] = useState<string | null>(null);
  const [storageRaw, setStorageRaw] = useState("");
  const [storage, setStorage] = useState<StorageSnapshot | null>(null);
  /** A save already sent `set` calls. Further saves stay off until a reload. */
  const [saveBlocked, setSaveBlocked] = useState(false);
  const saveLock = useRef(false);

  const load = useCallback(async () => {
    setErr(null);
    setReadErr(null);
    // Demo memory only when there is no controller link at all.
    try {
      await ensureMockConnected(host);
    } catch (e) {
      try {
        const fb = loadPidViaFallback();
        setValues(fb);
        setLoaded(fb);
        setUsingFallback(true);
        setStorage(null);
        setStorageRaw("");
        setReady(true);
        setSaveBlocked(false);
        setErr(`Protocol settings unavailable (${settingsErrorMessage(e)}); using local mockSettingsApi fallback`);
      } catch (fe) {
        setErr(settingsErrorMessage(fe));
        setReady(false);
        setSaveBlocked(false);
      }
      return;
    }
    setUsingFallback(false);
    try {
      const all = await retryWhileGateBusy(() => host.getAllSettings());
      const mapped = mapPidFromAll(all);
      let raw = "";
      let snap: StorageSnapshot | null = null;
      try {
        raw = await retryWhileGateBusy(() => host.sendCommand("storage"));
        snap = storageSnapshotFromRaw(raw);
      } catch { /* shown as accel_cal_saved: unknown; Save stays off without a snapshot */ }
      setValues(mapped);
      setLoaded(mapped);
      setStorageRaw(raw);
      setStorage(snap);
      setReady(true);
      setSaveBlocked(false);
    } catch (e) {
      setReady(false);
      setStorage(null);
      setSaveBlocked(false);
      setReadErr(`Could not read the controller's PID settings (${settingsErrorMessage(e)}). Nothing was changed. Defaults and Save stay disabled until a read succeeds.`);
    }
  }, [host]);

  useEffect(() => { void load(); }, [load]);

  const draftOk = pidDraftValid(values);
  const pageDirty = pidDirty(values, loaded);
  const canSave = ready && draftOk && pageDirty && !busy && !saveBlocked && !postFlashGate
    && (usingFallback || canSaveStorage(storage, connectionStatus === "connected", busy));

  function updateField(key: PidKey, raw: string) {
    setValues((prev) => ({ ...prev, [key]: numberFromInput(raw) }));
    setMsg(null);
    setErr(null);
  }

  function updateAirmode(on: boolean) {
    setValues((prev) => ({ ...prev, airmode: on ? 1 : 0 }));
    setMsg(null);
    setErr(null);
  }

  async function onSave() {
    if (!canSave || saveLock.current) return;
    saveLock.current = true;
    setBusy(true);
    setErr(null);
    setMsg(null);
    let sent = 0;
    const sendSet = async (run: () => Promise<unknown>) => {
      sent += 1;
      try { await run(); }
      catch (e) { if (isGateNotSent(e)) sent -= 1; throw e; }
    };
    try {
      if (usingFallback) {
        for (const key of PID_KEYS) {
          const reply = mockSettingsApi.set(key, values[key]);
          if (!reply.startsWith("ok ")) {
            const line = reply === "unknown key" || reply === "set failed" ? reply : "set failed";
            if (sent > 0) { setSaveBlocked(true); setErr(withMidSave(line)); }
            else setErr(line);
            return;
          }
          sent += 1;
        }
        const saveReply = mockSettingsApi.save();
        if (saveReply !== "saved") {
          const line = saveReply === "save failed" ? "save failed" : saveReply;
          setSaveBlocked(true);
          setErr(withMidSave(line));
          return;
        }
        setLoaded({ ...values });
        setMsg("Saved in demo memory only—not on a controller.");
        setSavedRev((r) => r + 1);
        await load();
        return;
      }
      await ensureMockConnected(host);
      for (const key of PID_KEYS) {
        await sendSet(() => host.setSetting(key as SettingsKey, formatSettingValue(values[key])));
      }
      await host.saveSettings();
      const after = await host.getAllSettings();
      for (const key of PID_KEYS) {
        const got = Number(after[key]);
        const want = values[key];
        if (!Number.isFinite(got) || Math.abs(got - want) > Math.max(1e-6, Math.abs(want) * 2e-6)) {
          throw new Error(`Readback mismatch: ${key}`);
        }
      }
      const read = mapPidFromAll(after);
      setValues(read);
      setLoaded(read);
      setMsg("Saved to controller flash and verified.");
      setSavedRev((r) => r + 1);
      await load();
    } catch (e) {
      if (sent > 0) {
        setSaveBlocked(true);
        setErr(midSaveFailure(e));
      } else {
        setErr(settingsErrorMessage(e));
      }
    } finally {
      saveLock.current = false;
      setBusy(false);
    }
  }

  const throttleInvalid = ready && !validateSettingValue("min_throttle", values.min_throttle);
  return (
    <div className="panel">
      <h2>PID</h2>
      <p className="muted">
        Per-axis P/I/D (incl. yaw D) via Protocol <code>get/set/save</code> and <code>defaults pid</code> (this tab only). Keys: {PID_KEYS.filter((k) => (SETTINGS_KEYS as readonly string[]).includes(k)).join(", ")}. AirMode default <strong>off</strong> (props-off safe); enable for idle I-term while armed. Min throttle default <strong>0.05</strong> (BF-like idle suggestion; independent of arm gate). Not flight-qualified.
      </p>
      {!ready && !err && !readErr && <p className="muted">Connecting / loading settings…</p>}
      <fieldset disabled={!ready || busy} style={{ border: 0, padding: 0 }}>
        <AxisGroup title="Roll" keys={ROLL_KEYS} values={values} ready={ready} onChange={updateField} />
        <AxisGroup title="Pitch" keys={PITCH_KEYS} values={values} ready={ready} onChange={updateField} />
        <AxisGroup title="Yaw" keys={YAW_KEYS} values={values} ready={ready} onChange={updateField} />
        <fieldset className="tuning-axis">
          <legend>Flight readiness (schema 4)</legend>
          <div className="tuning-grid">
            <div className="tuning-field">
              <label htmlFor="airmode">AirMode</label>
              <input id="airmode" type="checkbox" checked={values.airmode === 1} onChange={(e) => updateAirmode(e.target.checked)} />
            </div>
            <div className="tuning-field">
              <label htmlFor="min_throttle">Min throttle (0..0.2)</label>
              <input
                id="min_throttle"
                type="number"
                min={0}
                max={0.2}
                step="0.01"
                value={Number.isFinite(values.min_throttle) ? values.min_throttle : ""}
                aria-invalid={throttleInvalid ? true : undefined}
                onChange={(e) => updateField("min_throttle", e.target.value)}
              />
            </div>
          </div>
          <p className="muted">Enable AirMode + set Min throttle, then Save. Disarmed motors stay at 0. ARMING_THROTTLE_MAX arm gate remains 0.05 independently.</p>
        </fieldset>
      </fieldset>
      {ready && !draftOk && <p className="fail">Enter finite values within range.</p>}
      <div className="row" style={{ marginTop: "1rem" }}>
        <button type="button" className="primary" disabled={!canSave} onClick={() => void onSave()}>Save</button>
        <ScopedDefaults
          host={host}
          group="pid"
          onReread={load}
          savedRevision={savedRev}
          pageDirty={pageDirty}
          disabled={!ready || busy || postFlashGate}
          localFallback={usingFallback ? async () => { mockSettingsApi.defaults("pid"); await load(); } : undefined}
        />
      </div>
      {ready && !usingFallback && <AccelCalSavedNote raw={storageRaw} />}
      {readErr && (
        <div role="alert" data-testid="pid-read-error">
          <p className="fail">{readErr}</p>
          <button type="button" onClick={() => void load()}>Read again</button>
        </div>
      )}
      {err && <p className="fail" data-testid="pid-save-error">{err}</p>}
      {saveBlocked && !readErr && <button type="button" onClick={() => void load()}>Read again</button>}
      {msg && <p className="muted">Last reply: {msg}</p>}
    </div>
  );
}
