import {StoragePanel} from "../components/StoragePanel";
import { useEffect, useRef, useState } from "react";
import { useHost } from "../hooks/useHost";
import { parsePower, powerKeys, type PowerReading, type PowerKey } from "../protocol/power";
import type { CliCommand } from "../protocol";
const labels: Record<PowerKey, string> = {
  voltage_scale: "Voltage divider multiplier", current_mv_per_amp: "Current scale (mV/A; 0 = unavailable)",
  current_offset_mv: "Current zero offset (mV)", cells: "Cell count (1–6; 0 = not configured)",
  warning_cell_v: "Low voltage warning (V per cell)", critical_cell_v: "Critical voltage (V per cell)",
  capacity_mah: "Battery capacity (mAh; 0 = not configured)",
};
const warnings: Record<string, string> = {
  unavailable: "Voltage sensor unavailable", no_battery: "No battery detected", set_cells: "Set your battery cell count",
  check_cells: "Check cell count and voltage calibration", critical: "Critical battery voltage", low: "Low battery voltage",
  capacity: "80% of configured capacity consumed", ok: "Battery readings within configured limits",
};
export function PowerBatteryPage() {
  const { host, connectionStatus, postFlashGate } = useHost();
  const [reading, setReading] = useState<PowerReading | null>(null);
  const [draft, setDraft] = useState<Record<PowerKey, string> | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [measured, setMeasured] = useState("");
  const inFlight = useRef(false), generation = useRef(0);
  const connected = connectionStatus === "connected" && !postFlashGate;
  useEffect(() => {
    const epoch = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    setReading(null); setDraft(null); setMessage(""); setError("");
    if (!connected) return;
    async function poll() {
      if (epoch !== generation.current) return;
      if (!inFlight.current) {
        inFlight.current = true;
        try {
          const next = parsePower(await host.sendCommand("power"));
          if (epoch !== generation.current) return;
          setReading(next); setError("");
          setDraft(old => old ?? Object.fromEntries(powerKeys.map(k => [k, String(next[k])])) as Record<PowerKey, string>);
        } catch (e) { if (epoch === generation.current) { setReading(null); setError(String(e)); } }
        finally { inFlight.current = false; }
      }
      if (epoch === generation.current) timer = setTimeout(() => void poll(), 500);
    }
    void poll();
    return () => { ++generation.current; clearTimeout(timer); };
  }, [host, connected]);
  async function apply() {
    if (!draft || !connected) return;
    if (inFlight.current) { setMessage("A reading is in progress. Click Apply again in a moment."); return; }
    const epoch = generation.current;
    inFlight.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const numbers = powerKeys.map(k => Number(draft[k]));
      if (powerKeys.some(k => !draft[k].trim()) || numbers.some(n => !Number.isFinite(n) || n < 0)) throw new Error("Enter valid nonnegative numbers.");
      if (!Number.isInteger(numbers[3]) || !Number.isInteger(numbers[6])) throw new Error("Cell count and capacity must be whole numbers.");
      const command = `power_config ${numbers.map(n => n.toFixed(6).replace(/\.?0+$/, "") || "0").join(" ")}` as CliCommand;
      const next = parsePower(await host.sendCommand(command));
      if (epoch !== generation.current) return;
      setReading(next); setDraft(Object.fromEntries(powerKeys.map(k => [k, String(next[k])])) as Record<PowerKey, string>);
      setMessage("Applied and read back. Save to controller to retain settings; consumption starts a new session.");
    } catch (e) { if (epoch === generation.current) setError(String(e)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const live = connected && reading?.valid === 1;
  const current = live && reading?.current_valid === 1;
  const consumption = current && reading?.consumption_valid === 1;
  const value = (n: number | undefined, available: boolean, units: string, digits = 2) => available && n !== undefined ? `${n.toFixed(digits)} ${units}` : "Unavailable";
  const remaining = reading && reading.capacity_mah > 0 ? Math.max(0, 100*(1-reading.consumed_mah/reading.capacity_mah)) : undefined;
  return <div className="panel">
    <h2>Power &amp; Battery</h2>
    <StoragePanel requiredScope="power" blocked={busy||!draft||!reading||powerKeys.some(k=>!draft[k].trim()||Number(draft[k])!==reading[k])}/>
    <p className="muted">Voltage source: onboard ADC. Current source: external analog sensor, when fitted and configured.</p>
    {!connected && <p role="status">Connect your board to read battery data.</p>}
    {error && <p className="fail" role="alert">{error}</p>}
    {reading && <p role="status">{warnings[reading.warning] ?? "Unknown battery status"}</p>}
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(170px, 1fr))",gap:"1rem"}}>
      {[
        ["Battery voltage", value(reading?.voltage, live, "V")],
        ["Average cell voltage", value(reading && reading.cells ? reading.voltage/reading.cells : undefined, live, "V")],
        ["Current", value(reading?.amps, current, "A")],
        ["Power", value(reading ? reading.voltage*reading.amps : undefined, current, "W")],
        ["Consumed", value(reading?.consumed_mah, consumption, "mAh", 0)],
        ["Capacity remaining (estimate)", value(remaining, consumption, "%", 0)],
      ].map(([label, display]) => <div className="panel" key={label}><span className="muted">{label}</span><h3>{display}</h3></div>)}
    </div>
    <p className="muted">Cell voltage is the pack average. Current and capacity require a calibrated sensor measuring the whole pack. ESC telemetry is not supported yet.</p>
    <h3>Battery and sensor settings</h3>
    <p className="muted">Current scale uses mV per amp. For a Betaflight scale such as 275, the corresponding starting value is 27.5 mV/A. Verify the scale for your actual sensor.</p>
    <p>Apply settings, then Save to controller to retain them after reboot. Warnings appear here; they do not stop motors or activate receiver failsafe.</p>
    <fieldset disabled={!connected || !draft || busy} style={{border:0,padding:0}}>
      {powerKeys.map(key => <label key={key} style={{display:"block",marginBottom:"0.7rem"}}>
        {labels[key]}<input type="number" step={key === "cells" || key === "capacity_mah" ? "1" : "any"} min="0" value={draft?.[key] ?? ""}
          onChange={e => setDraft(old => old ? {...old,[key]:e.target.value} : old)} style={{display:"block"}} />
      </label>)}
      <button onClick={() => void apply()} disabled={busy}>Apply to board</button>
    </fieldset>
    <h3>Voltage calibration</h3>
    <p>With the pack connected and props removed, measure pack voltage with a multimeter. Enter it below to calculate the divider, then apply the settings above.</p>
    <label>Measured pack voltage (V) <input type="number" min="0" step="any" value={measured} onChange={e => setMeasured(e.target.value)} /></label>{" "}
    <button disabled={!live || !reading?.present || !draft || busy} onClick={() => {
      const volts=Number(measured);
      if (!reading || !draft || !Number.isFinite(volts) || volts<=2 || reading.voltage<=2) {setError("Enter the measured pack voltage.");return;}
      setDraft({...draft,voltage_scale:String(Number((reading.voltage_scale*volts/reading.voltage).toFixed(6)))});
      setMessage("Divider calculated. Apply the settings to update the board.");
    }}>Calculate divider</button>
    {message && <p role="status">{message}</p>}
  </div>;
}
