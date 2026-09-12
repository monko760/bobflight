import { useCallback, useEffect, useState } from "react";
import { useHost } from "../hooks/useHost";
import {
  SETTINGS_KEYS,
  type SettingsKey,
} from "../protocol";
import { ensureMockConnected } from "../protocol/ensureConnected";
import {
  mockSettingsApi,
  RATE_KEYS,
  type RateKey,
} from "../tuning/mockSettingsApi";
import type { RatesConfig } from "../tuning/mockTuningStore";

const MAX_KEYS: RateKey[] = ["rate_max_roll", "rate_max_pitch", "rate_max_yaw"];

function emptyRates(): RatesConfig {
  return {
    rate_max_roll: 0,
    rate_max_pitch: 0,
    rate_max_yaw: 0,
    rate_expo: 0,
  };
}

function formatSettingValue(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(8).replace(/\.?0+$/, "");
  return s.length ? s : "0";
}

function mapRatesFromAll(
  all: Record<string, string>,
): RatesConfig {
  const next = emptyRates();
  for (const key of RATE_KEYS) {
    const raw = all[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) next[key] = n;
  }
  return next;
}

/** FALLBACK ONLY — local mockSettingsApi when host settings throw / unavailable. */
function loadRatesViaFallback(): RatesConfig {
  const next = emptyRates();
  for (const key of RATE_KEYS) {
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

export function RatesPage() {
  const { host } = useHost();
  const [values, setValues] = useState<RatesConfig>(emptyRates);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      await ensureMockConnected(host);
      const all = await host.getAllSettings();
      setValues(mapRatesFromAll(all));
      setUsingFallback(false);
      setReady(true);
    } catch (e) {
      // FALLBACK: Protocol host settings unavailable — use local mockSettingsApi.
      try {
        setValues(loadRatesViaFallback());
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

  function updateField(key: RateKey, raw: string) {
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
      for (const key of RATE_KEYS) {
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
      setMsg("saved");
      await load();
      return;
    }

    try {
      await ensureMockConnected(host);
      for (const key of RATE_KEYS) {
        await host.setSetting(key as SettingsKey, formatSettingValue(values[key]));
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
      const reply = mockSettingsApi.defaults("rates");
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
      // restoreDefaults resets all 12 keys (FW contract); re-load rates fields after.
      await host.restoreDefaults();
      setMsg("defaults restored");
      await load();
    } catch (e) {
      setErr(settingsErrorMessage(e));
    }
  }

  return (
    <div className="panel">
      <h2>Rates</h2>
      <p className="muted">
        Per-axis max rates plus shared expo via Protocol{" "}
        <code>get/set/save/defaults</code> on mock transport. Keys:{" "}
        {RATE_KEYS.filter((k) =>
          (SETTINGS_KEYS as readonly string[]).includes(k),
        ).join(", ")}
        .
      </p>

      {!ready && !err && <p className="muted">Connecting / loading settings…</p>}

      <div className="tuning-grid">
        {MAX_KEYS.map((key) => (
          <div key={key} className="tuning-field">
            <label htmlFor={key}>{key}</label>
            <input
              id={key}
              type="number"
              step="1"
              value={values[key]}
              onChange={(e) => updateField(key, e.target.value)}
            />
          </div>
        ))}
        <div className="tuning-field">
          <label htmlFor="rate_expo">rate_expo</label>
          <input
            id="rate_expo"
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={values.rate_expo}
            onChange={(e) => updateField("rate_expo", e.target.value)}
          />
        </div>
      </div>

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
