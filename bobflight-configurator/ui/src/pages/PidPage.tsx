import { useCallback, useEffect, useState } from "react";
import { useHost } from "../hooks/useHost";
import {
  SETTINGS_KEYS,
  type SettingsKey,
} from "../protocol";
import { ensureMockConnected } from "../protocol/ensureConnected";
import {
  mockSettingsApi,
  PID_KEYS,
  type PidKey,
} from "../tuning/mockSettingsApi";
import type { PidConfig } from "../tuning/mockTuningStore";

const ROLL_KEYS: PidKey[] = ["pid_roll_p", "pid_roll_i", "pid_roll_d"];
const PITCH_KEYS: PidKey[] = ["pid_pitch_p", "pid_pitch_i", "pid_pitch_d"];
const YAW_KEYS: PidKey[] = ["pid_yaw_p", "pid_yaw_i"];

function emptyPid(): PidConfig {
  return {
    pid_roll_p: 0,
    pid_roll_i: 0,
    pid_roll_d: 0,
    pid_pitch_p: 0,
    pid_pitch_i: 0,
    pid_pitch_d: 0,
    pid_yaw_p: 0,
    pid_yaw_i: 0,
    min_throttle: 0.05,
    airmode: 0,
  };
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

/** FALLBACK ONLY — local mockSettingsApi when host settings throw / unavailable. */
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

function AxisGroup({
  title,
  keys,
  values,
  onChange,
}: {
  title: string;
  keys: readonly PidKey[];
  values: PidConfig;
  onChange: (key: PidKey, raw: string) => void;
}) {
  return (
    <fieldset className="tuning-axis">
      <legend>{title}</legend>
      <div className="tuning-grid">
        {keys.map((key) => (
          <div key={key} className="tuning-field">
            <label htmlFor={key}>{key}</label>
            <input
              id={key}
              type="number"
              step="0.00001"
              value={values[key]}
              onChange={(e) => onChange(key, e.target.value)}
            />
          </div>
        ))}
      </div>
    </fieldset>
  );
}

export function PidPage() {
  const { host } = useHost();
  const [values, setValues] = useState<PidConfig>(emptyPid);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      await ensureMockConnected(host);
      const all = await host.getAllSettings();
      setValues(mapPidFromAll(all));
      setUsingFallback(false);
      setReady(true);
    } catch (e) {
      // FALLBACK: Protocol host settings unavailable — use local mockSettingsApi.
      try {
        setValues(loadPidViaFallback());
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
  }, [host]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateField(key: PidKey, raw: string) {
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
    if (usingFallback) {
      for (const key of PID_KEYS) {
        const reply = mockSettingsApi.set(key, values[key]);
        if (!reply.startsWith("ok ")) {
          setErr(reply === "unknown key" || reply === "set failed" ? reply : "set failed");
          return;
        }
      }
      const saveReply = mockSettingsApi.save();
      if (saveReply !== "saved") {
        setErr(saveReply === "save failed" ? "save failed" : saveReply);
        return;
      }
      setMsg("Saved in demo memory only—not on a controller.");
      await load();
      return;
    }

    try {
      await ensureMockConnected(host);
      for (const key of PID_KEYS) {
        await host.setSetting(key as SettingsKey, formatSettingValue(values[key]));
      }
      await host.saveSettings();
      setMsg("Saved to controller flash and verified.");
      await load();
    } catch (e) {
      setErr(settingsErrorMessage(e));
    }
  }

  async function onDefaults() {
    setErr(null);
    setMsg(null);
    if (usingFallback) {
      const reply = mockSettingsApi.defaults("pid");
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
      // restoreDefaults resets all settings keys (FW contract); refresh PID fields after.
      await host.restoreDefaults();
      setMsg("defaults restored");
      await load();
    } catch (e) {
      setErr(settingsErrorMessage(e));
    }
  }

  return (
    <div className="panel">
      <h2>PID</h2>
      <p className="muted">
        Per-axis P/I/D (yaw D deferred) via Protocol{" "}
        <code>get/set/save/defaults</code> on mock transport. Keys:{" "}
        {PID_KEYS.filter((k) =>
          (SETTINGS_KEYS as readonly string[]).includes(k),
        ).join(", ")}
        . AirMode default <strong>off</strong> (props-off safe); enable for idle
        I-term while armed. Min throttle default <strong>0.05</strong> (BF-like
        idle suggestion; independent of arm gate). Not flight-qualified.
      </p>

      {!ready && !err && <p className="muted">Connecting / loading settings…</p>}

      <AxisGroup
        title="Roll"
        keys={ROLL_KEYS}
        values={values}
        onChange={updateField}
      />
      <AxisGroup
        title="Pitch"
        keys={PITCH_KEYS}
        values={values}
        onChange={updateField}
      />
      <AxisGroup
        title="Yaw"
        keys={YAW_KEYS}
        values={values}
        onChange={updateField}
      />

      <fieldset className="tuning-axis">
        <legend>Flight readiness (schema 4)</legend>
        <div className="tuning-grid">
          <div className="tuning-field">
            <label htmlFor="airmode">AirMode</label>
            <input
              id="airmode"
              type="checkbox"
              checked={values.airmode === 1}
              onChange={(e) =>
                updateField("airmode", e.target.checked ? "1" : "0")
              }
            />
          </div>
          <div className="tuning-field">
            <label htmlFor="min_throttle">Min throttle (0..0.2)</label>
            <input
              id="min_throttle"
              type="number"
              min={0}
              max={0.2}
              step="0.01"
              value={values.min_throttle}
              onChange={(e) => updateField("min_throttle", e.target.value)}
            />
          </div>
        </div>
        <p className="muted">
          Enable AirMode + set Min throttle, then Save. Disarmed motors stay at 0.
          ARMING_THROTTLE_MAX arm gate remains 0.05 independently.
        </p>
      </fieldset>

      <div className="row" style={{ marginTop: "1rem" }}>
        <button type="button" className="primary" onClick={() => void onSave()}>
          Save
        </button>
        <button type="button" className="ghost" onClick={() => void onDefaults()}>
          Defaults
        </button>
      </div>
      {msg && <p className="muted">Last reply: {msg}</p>}
      {err && <p className="fail">{err}</p>}
    </div>
  );
}
