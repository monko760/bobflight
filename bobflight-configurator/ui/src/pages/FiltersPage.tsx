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

const FILTER_LABELS: Record<FilterKey, string> = {
  gyro_lpf_hz: "Gyro LPF (Hz)",
  dterm_lpf_hz: "D-term LPF (Hz)",
};

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

  const load = useCallback(async () => {
    setErr(null);
    try {
      await ensureMockConnected(host);
      const all = await host.getAllSettings();
      setValues(mapFiltersFromAll(all));
      setUsingFallback(false);
      setReady(true);
    } catch (e) {
      try {
        setValues(loadFiltersViaFallback());
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
    for (const key of FILTER_KEYS) {
      if (!validateFilterHz(values[key])) {
        setErr("set failed");
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

  const protocolKeys = FILTER_KEYS.filter((k) =>
    (SETTINGS_KEYS as readonly string[]).includes(k),
  );

  return (
    <div className="panel">
      <h2>Filters</h2>
      <p className="muted">
        Gyro and D-term low-pass only (Filters R0 — no notches). Protocol{" "}
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

      <div className="row" style={{ marginTop: "1rem" }}>
        <button type="button" className="primary" onClick={() => void onSave()}>
          Save
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
