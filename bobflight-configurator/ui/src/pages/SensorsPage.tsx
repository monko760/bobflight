import {StoragePanel} from "../components/StoragePanel";
/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState } from "react";
import { useSensorTelemetry } from "../hooks/useSensorTelemetry";
import {
  AXIS_FACES,
  checkActionGates,
  countCapturedFaces,
  formatFloat,
  formatVector,
  isFaceCaptured,
} from "../sensors/telemetry";

export function SensorsPage() {
  const {
    connected,
    snapshot,
    fresh,
    fps,
    error,
    reply,
    pending,
    oldFirmware,
    propsOff,
    setPropsOff,
    stationary,
    setStationary,
    command,
    pollDetailedCalibration,
  } = useSensorTelemetry();

  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [copyResult,setCopyResult]=useState("");
  const [storagePending,setStoragePending]=useState(false);
  useEffect(()=>{
    if(snapshot?.cal_apply_detail && !snapshot.accel_calibrated)setShowDiagnostics(true);
  },[snapshot?.cal_apply_detail,snapshot?.accel_calibrated]);

  useEffect(() => {
    pollDetailedCalibration(showDiagnostics);
  }, [showDiagnostics, pollDetailedCalibration]);

  const gyro = snapshot?.gyro_dps ?? [0, 0, 0];
  const acc = snapshot?.accel_g ?? [0, 0, 0];
  const rawAcc = snapshot?.accel_raw_g ?? [0, 0, 0];
  const angles = snapshot?.attitude_deg ?? [0, 0, 0];

  const gyroOk = snapshot?.gyro_ok ?? false;
  const hasFreshCorrectVectors =
    fresh && gyroOk && snapshot?.attitude_ready===true && angles.length === 3 && angles.every(Number.isFinite);

  const roll = hasFreshCorrectVectors ? angles[0] : 0;
  const pitch = hasFreshCorrectVectors ? angles[1] : 0;

  const magnitude =
    fresh && acc.length === 3 ? Math.hypot(acc[0], acc[1], acc[2]) : null;

  // Project a quad in body coordinates (x forward, y right, z down).
  const project = (x: number, y: number): [number, number] => {
    const r = (roll * Math.PI) / 180;
    const p = (pitch * Math.PI) / 180;
    const yy = y * Math.cos(r);
    const z = y * Math.sin(r);
    const xx = x * Math.cos(p) + z * Math.sin(p);
    const zz = -x * Math.sin(p) + z * Math.cos(p);
    return [240 + yy * 0.88, 160 - xx * 0.58 + zz * 0.7];
  };

  const motors = [
    project(90, -90),
    project(90, 90),
    project(-90, -90),
    project(-90, 90),
  ];
  const nose = project(115, 0);

  // Action gate evaluations
  const gateCtx = {
    connected,
    snapshot,
    fresh,
    propsOff,
    stationary,
    pending: pending || storagePending,
  };

  const gyroGate = checkActionGates("gyro_cal", gateCtx);
  const levelGate = checkActionGates("accel_level", gateCtx);
  const accelStartGate = checkActionGates("accel_start", gateCtx);
  const accelFaceGate = checkActionGates("accel_face", gateCtx);
  const accelApplyGate = checkActionGates("accel_apply", gateCtx);
  const accelCancelGate = checkActionGates("accel_cancel", gateCtx);

  const calFaces = snapshot?.cal_faces ?? 0;
  const calFace = snapshot?.cal_face ?? -1;
  const calState = snapshot?.cal_state ?? "idle";
  const calSamples = snapshot?.cal_samples ?? 0;
  const calRequired = snapshot?.cal_required ?? 0;
  const calReason = snapshot?.cal_reason ?? "";

  const isAccelCalActive = calState === "accel_wait" || calState === "accel_collect";

  return (
    <div className="panel">
      <h2>Live Sensors & Calibration</h2>
      <StoragePanel requiredScope="accel_calibration" onPending={setStoragePending} blocked={pending||!fresh||snapshot?.cal_manual===true} revision={snapshot?.cal_state==="complete"?2:snapshot?.accel_calibrated?1:0}/>
      <p>
        Move the quad gently. Gyro measures rotation speed; acceleration includes gravity.
      </p>

      {snapshot?.cal_bench_relaxed && <p role="alert" style={{border:"2px solid currentColor",padding:"12px"}}>
        <strong>EXPERIMENTAL BENCH-ONLY CALIBRATION — NOT FOR FLIGHT.</strong> Relaxed pose limits are enabled.
        Apply can install a diagnostic correction, not a flight-qualified calibration. Keep propellers removed;
        firmware arming is disabled. Pair limit: 0.10 g; pose-component limit: 0.15 g. RAM-only.
      </p>}
      {/* Banner message */}
      <p
        role="status"
        className={
          oldFirmware || error || !connected
            ? "banner-warn"
            : !fresh
            ? "banner-warn"
            : !gyroOk
            ? "banner-warn"
            : "muted"
        }
      >
        {!connected
          ? "Connect the board to see live readings."
          : oldFirmware
          ? "Update firmware required — sensor telemetry protocol not supported by this firmware version."
          : error
          ? `Telemetry error: ${error}`
          : !fresh
          ? "Waiting for fresh telemetry… (stale or unavailable)"
          : !gyroOk
          ? `Sensor not healthy (${snapshot?.cal_reason || "gyro error"}).`
          : `Receiving live sensor data (~${fps} FPS)`}
      </p>

      {/* Preflight Safety Gates */}
      <div
        style={{
          background: "#1e293b",
          padding: "12px 16px",
          borderRadius: "8px",
          marginBottom: "16px",
          display: "flex",
          gap: "24px",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={propsOff}
            onChange={(e) => setPropsOff(e.target.checked)}
          />
          <strong>Props removed / Bench safety confirmed</strong>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={stationary}
            onChange={(e) => setStationary(e.target.checked)}
          />
          <strong>Stationary on flat bench confirmed</strong>
        </label>
      </div>

      {/* Orientation SVG & Live Status Grid */}
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ flex: "1 1 320px", maxWidth: 520 }}>
          <svg
            viewBox="0 0 480 300"
            role="img"
            aria-label={
              hasFreshCorrectVectors
                ? `Quad tilt: roll ${roll.toFixed(1)}°, pitch ${pitch.toFixed(1)}°`
                : "Quad orientation unavailable"
            }
            style={{ width: "100%", background: "#101b2a", borderRadius: 12 }}
          >
            <path d="M40 160H440 M240 30V280" stroke="#334155" strokeDasharray="5 5" />
            <text x="240" y="25" textAnchor="middle" fill="#94a3b8" fontSize="13">
              FRONT
            </text>
            {hasFreshCorrectVectors ? (
              <g>
                {motors.map(([x, y], i) => (
                  <g key={i}>
                    <line
                      x1="240"
                      y1="160"
                      x2={x}
                      y2={y}
                      stroke={i < 2 ? "#38bdf8" : "#94a3b8"}
                      strokeWidth="10"
                    />
                    <ellipse
                      cx={x}
                      cy={y}
                      rx="28"
                      ry="16"
                      fill="#172c40"
                      stroke={i < 2 ? "#38bdf8" : "#94a3b8"}
                      strokeWidth="3"
                    />
                  </g>
                ))}
                <circle cx="240" cy="160" r="17" fill="#e2e8f0" />
                <line
                  x1="240"
                  y1="160"
                  x2={nose[0]}
                  y2={nose[1]}
                  stroke="#fb923c"
                  strokeWidth="5"
                />
                <circle cx={nose[0]} cy={nose[1]} r="7" fill="#fb923c" />
              </g>
            ) : (
              <text x="240" y="155" textAnchor="middle" fill="#cbd5e1">
                Orientation unavailable (requires fresh sensor telemetry)
              </text>
            )}
          </svg>
          <p className="muted" style={{ marginTop: "6px", fontSize: "0.85rem" }}>
            Roll and pitch projection. Blue arms mark front. View is illustrative — verify axis
            direction on real quad.
          </p>
        </div>

        <div style={{ flex: "1 1 260px" }}>
          <div className="status-grid">
            <div className="status-card">
              <div className="k">Roll</div>
              <div className="v">{hasFreshCorrectVectors ? `${roll.toFixed(1)}°` : "—"}</div>
            </div>
            <div className="status-card">
              <div className="k">Pitch</div>
              <div className="v">{hasFreshCorrectVectors ? `${pitch.toFixed(1)}°` : "—"}</div>
            </div>
            <div className="status-card">
              <div className="k">Yaw</div>
              <div className="v">Not measured</div>
            </div>
            <div className="status-card">
              <div className="k">Total Accel</div>
              <div className="v">{magnitude !== null ? `${magnitude.toFixed(3)} g` : "—"}</div>
            </div>
            <div className="status-card">
              <div className="k">Gyro Calibrated</div>
              <div className="v">
                {fresh ? (snapshot?.gyro_calibrated ? "yes" : "no") : "—"}
              </div>
            </div>
            <div className="status-card">
              <div className="k">Accel Calibrated</div>
              <div className="v">
                {fresh ? (snapshot?.accel_calibrated ? (snapshot.cal_bench_relaxed ? "BENCH ONLY" : "yes") : "no") : "—"}
              </div>
            </div>
          </div>

          <table
            style={{
              width: "100%",
              fontVariantNumeric: "tabular-nums",
              marginTop: "12px",
            }}
          >
            <thead>
              <tr>
                <th>Axis</th>
                <th>Gyro (°/s)</th>
                <th>Accel (g)</th>
                <th>Before correction (g)</th>
              </tr>
            </thead>
            <tbody>
              {["X / roll", "Y / pitch", "Z / yaw"].map((axis, i) => (
                <tr key={axis}>
                  <td>{axis}</td>
                  <td>{fresh ? formatFloat(gyro[i], 2) : "—"}</td>
                  <td>{fresh ? formatFloat(acc[i], 3) : "—"}</td>
                  <td>{fresh ? formatFloat(rawAcc[i], 3) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Gyro Calibration Section */}
      <h3 style={{ marginTop: "24px" }}>Gyro Calibration</h3>
      <p>
        Set the quad down and keep it completely still. Gyro calibration measures angular-rate offsets;
        it does not require the accelerometer to be calibrated first and does not establish flight readiness.
      </p>
      <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
        <button
          disabled={!gyroGate.allowed}
          onClick={() => void command("calibrate_gyro")}
        >
          {pending ? "Sending command…" : "Calibrate gyro"}
        </button>
        {calState === "gyro" && (
          <button disabled={!accelCancelGate.allowed} onClick={()=>void command("calibration_cancel")}>
            Cancel gyro calibration
          </button>
        )}
        {calState === "gyro" && (
          <span className="muted">
            Calibrating gyro: {calSamples}/{calRequired} samples {calReason ? `(${calReason})` : ""}
          </span>
        )}
      </div>

      {!gyroGate.allowed && calState!=="gyro" && (
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "4px" }}>
          Blocked: {gyroGate.reasons.join("; ")}
        </p>
      )}

      {calState==="gyro" && <p className="muted">Keep still while samples accumulate, or use Cancel gyro calibration above. Cancel preserves applied coefficients but discards unfinished face captures.</p>}

      <h3 style={{marginTop:"28px"}}>Accelerometer level calibration</h3>
      <p>Place the board upright on a known level surface and keep it still. This applies a stationary offset so that level reads 0, 0, +1 g. Gravity is retained; scale is not measured by a single pose.</p>
      <p>Gyro calibration subtracts stationary rotation bias automatically. Level calibration is separate, replaces accelerometer offsets and resets scales to 1. Previous applied coefficients survive a failed or cancelled attempt.</p>
      <button disabled={!levelGate.allowed} onClick={()=>void command("calibrate_accel level")}>Calibrate accelerometer level</button>
      {calState==="accel_level" && <>
        <span role="status"> Collecting stationary level samples: {calSamples}/{calRequired}. {calReason}</span>
        <button disabled={!accelCancelGate.allowed} onClick={()=>void command("calibration_cancel")}>Cancel level calibration</button>
      </>}
      {!levelGate.allowed && calState!=="accel_level" && <p className="muted">{levelGate.reasons.join("; ")}</p>}
      <p role="status">{!fresh?"Calibration status unavailable":snapshot?.cal_manual?"Calibration session active. Previously applied correction is retained until success.":snapshot?.calibration_storage==="flash-verified"?"Accelerometer correction saved in flash. This is not flight qualification.":snapshot?.calibration_storage==="unsaved"?"Accelerometer correction applied in RAM. Use Save to controller to keep it after power loss.":snapshot?.accel_calibrated?"Accelerometer correction applied; storage status: "+snapshot.calibration_storage:"No accelerometer correction applied."}</p>
      <p>Gyro offset applied: {fresh?(snapshot?.gyro_bias_applied===undefined?"not separately reported":snapshot.gyro_bias_applied?"yes":"no"):"unavailable"}. Gyro readiness can be temporarily withheld during any manual calibration session.</p>
      {snapshot?.cal_apply_detail && <p role="status">Calibration result: {snapshot.cal_apply_detail}</p>}
      <details>
      <summary>Advanced: six-face offset and scale calibration</summary>
      {/* Accelerometer 6-Face Calibration Section */}
      <h3 style={{ marginTop: "28px" }}>Accelerometer 6-Face Calibration</h3>

      {/* Manual Calibration Guidance & Mandatory Notices */}
      <div
        style={{
          background: "#0f172a",
          borderLeft: "4px solid #38bdf8",
          padding: "12px 16px",
          marginBottom: "16px",
          borderRadius: "4px",
          fontSize: "0.9rem",
          lineHeight: "1.4",
        }}
      >
        <p style={{ margin: "0 0 8px 0" }}>
          <strong>Important Calibration Instructions & Diagnostics:</strong>
        </p>
        <ul style={{ margin: "0", paddingLeft: "20px" }}>
          <li>
            <strong>RAW Selected Signed Axis Dominates:</strong> When capturing each face, align the
            aligned, pre-correction axis directly vertical (+X, -X, +Y, -Y, +Z, -Z) against gravity. Do
            not rely on assumed board frame front alignment, as board rotation settings may differ.
          </li>
          <li>
            <strong>Table-Flat Disclaimer:</strong> Resting the quad flat on a table only
            provides at most one face. Choose its sign from the live raw readings, not a mounting assumption. One position does NOT calibrate all six faces.
          </li>
          <li>
            <strong>Raw Capture Is Not Corrected Gravity:</strong> A raw reading near 0.8 g
            on one face and 1.2 g on its opposite can be an offset. The updated firmware
            can stage bounded raw measurements, but Apply requires all six stationary
            faces to agree on one offset/scale solution. Gyro bias calibration is separate from accelerometer calibration;
            a calibrated gyro does not mean the accelerometer or flight checks passed.
            A large accepted offset needs investigation; it is not proof of bad hardware or flight qualification.
          </li>
          <li>
            <strong>Apply, then Save:</strong> Successful Apply updates RAM. Use Save to controller only when the connected firmware advertises flash storage, then verify after a full power cycle. Gyro bias is recalibrated at startup, not saved. Pre-correction samples and incomplete candidates are never saved.
          </li>
        </ul>
      </div>

      <p>Green face cards mean <strong>captured</strong>, not calibrated. Apply must validate all six measurements together.</p>
      {snapshot?.cal_apply_detail && <p role="status" style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>
        <strong>{snapshot.accel_calibrated?(snapshot.cal_bench_relaxed?"Experimental bench Apply result":"Last Apply result"):"Apply diagnostics"}{fresh?"":" (stale)"}:</strong> {snapshot.cal_apply_detail}
      </p>}
      {/* 6-Face Controls & Progress */}
      <div style={{ marginBottom: "16px" }}>
        <div
          style={{
            display: "flex",
            gap: "12px",
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: "12px",
          }}
        >
          <button
            disabled={!accelStartGate.allowed || isAccelCalActive}
            onClick={() => void command("calibrate_accel start")}
          >
            Start 6-Face Calibration
          </button>

          <button
            disabled={!accelApplyGate.allowed}
            onClick={() => void command("calibrate_accel apply")}
          >
            Apply Calibration (All 6 Faces)
          </button>

          <button
            disabled={!accelCancelGate.allowed}
            onClick={() => void command("calibration_cancel")}
          >
            Cancel Calibration
          </button>
        </div>

        <div style={{ display: "flex", gap: "16px", alignItems: "center", fontSize: "0.9rem" }}>
          <span>
            Captured Faces: <strong>{countCapturedFaces(calFaces)} / 6</strong>
          </span>
          {calState === "accel_collect" && (
            <span>
              Samples: <strong>{calSamples} / {calRequired}</strong>
            </span>
          )}
          {calReason && <span className="muted">Reason: {calReason}</span>}
        </div>
      </div>

      {/* 6 Face signed-axis capture buttons */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: "12px",
          marginBottom: "16px",
        }}
      >
        {AXIS_FACES.map((face) => {
          const captured = isFaceCaptured(calFaces, face.index);
          const isCurrentFace = calFace === face.index;

          return (
            <div
              key={face.key}
              style={{
                background: isCurrentFace ? "#1e3a8a" : captured ? "#064e3b" : "#1e293b",
                border: isCurrentFace
                  ? "2px solid #3b82f6"
                  : captured
                  ? "1px solid #10b981"
                  : "1px solid #334155",
                borderRadius: "8px",
                padding: "12px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <strong>{face.label}</strong>
                {captured ? (
                  <span style={{ color: "#10b981", fontWeight: "bold" }}>✓ Done</span>
                ) : (
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    Not set
                  </span>
                )}
              </div>
              <p className="muted" style={{ fontSize: "0.78rem", margin: 0, minHeight: "2.4em" }}>
                {face.description}
              </p>
              <button
                style={{ marginTop: "auto" }}
                disabled={!accelFaceGate.allowed}
                onClick={() => void command(`calibrate_accel ${face.key}`)}
              >
                {isCurrentFace && pending
                  ? "Capturing…"
                  : `Capture ${face.shortLabel}`}
              </button>
            </div>
          );
        })}
      </div>

      </details>

      {reply && (
        <p role="status" style={{ marginTop: "8px" }}>
          Command response: <code>{reply}</code>
        </p>
      )}

      {/* Diagnostics / Collapsible Config View */}
      <div style={{ marginTop: "28px" }}>
        <button
          onClick={() => setShowDiagnostics((prev) => !prev)}
          style={{ background: "transparent", border: "1px stroke #475569", color: "#94a3b8" }}
        >
          {showDiagnostics ? "Hide Sensor Diagnostics" : "Show Sensor Diagnostics & Coefficients"}
        </button>

        {showDiagnostics && snapshot && (
          <div
            style={{
              background: "#0f172a",
              padding: "12px 16px",
              borderRadius: "8px",
              marginTop: "12px",
              fontFamily: "monospace",
              fontSize: "0.85rem",
            }}
          >
            <p style={{ margin: "0 0 6px 0" }}>
              Sensor Chip: <strong>{snapshot.sensor_chip ?? "Unknown"}</strong> | Protocol Version:{" "}
              <strong>{snapshot.sensors_version}</strong> | Storage:{" "}
              <strong>{snapshot.calibration_storage}</strong>
            </p>
            <p style={{ margin: "0 0 6px 0" }}>
              Gyro Bias: <code>{formatFloat(snapshot.gyro_bias?.[0], 3)}, {formatFloat(snapshot.gyro_bias?.[1], 3)}, {formatFloat(snapshot.gyro_bias?.[2], 3)}</code>
            </p>
            <p style={{ margin: "0 0 6px 0" }}>
              Accel Bias: <code>{formatFloat(snapshot.accel_bias?.[0], 3)}, {formatFloat(snapshot.accel_bias?.[1], 3)}, {formatFloat(snapshot.accel_bias?.[2], 3)}</code>
            </p>
            <p style={{ margin: "0 0 6px 0" }}>
              Accel Scale: <code>{formatFloat(snapshot.accel_scale?.[0], 4)}, {formatFloat(snapshot.accel_scale?.[1], 4)}, {formatFloat(snapshot.accel_scale?.[2], 4)}</code>
            </p>
            <p style={{ margin: "0" }}>
              Hex Readbacks: Gyro Config <code>{snapshot.mpu_gyro_config ?? "N/A"}</code> | Accel
              Config <code>{snapshot.mpu_accel_config ?? "N/A"}</code>
            </p>
            <p>Sensor-frame counts before rotation: <code>{snapshot.accel_counts?.join(" ") ?? "Not reported by this firmware"}</code>. Counts/g: {snapshot.accel_counts_per_g ?? "not reported"}.</p>
            <p>Acceleration register bytes: <code>{snapshot.accel_register_bytes ?? "not reported"}</code>. The g-valued before-correction readings are already scaled and aligned.</p>
            <p>Calibration policy: <strong>{snapshot.cal_bench_relaxed===true?"RELAXED BENCH ONLY — never flight-qualified":snapshot.cal_bench_relaxed===false?"Standard checks":"Not reported by this firmware"}</strong></p>
            <h4>Captured aligned pre-correction faces (g), not applied coefficients</h4>
            {snapshot.cal_raw_faces ? <table style={{width:"100%",textAlign:"left"}}>
              <thead><tr><th>Face</th><th>Raw X</th><th>Raw Y</th><th>Raw Z</th></tr></thead>
              <tbody>{AXIS_FACES.map(face=>{
                const v=snapshot.cal_raw_faces?.[face.index];
                return <tr key={face.key}><td>{face.shortLabel}</td>{v?v.map((n,i)=><td key={i}>{formatFloat(n,5)}</td>):<td colSpan={3}>{isFaceCaptured(snapshot.cal_faces,face.index)?"Unavailable":"Not captured"}</td>}</tr>;
              })}</tbody>
            </table>:<p>Staged numerical diagnostics unavailable from this firmware.</p>}
            <p>Candidate bias (g): {snapshot.cal_candidate_valid?formatVector(snapshot.cal_candidate_bias!,5):"Unavailable until a finite calibration solve"}</p>
            <p>Candidate scale: {snapshot.cal_candidate_valid?formatVector(snapshot.cal_candidate_scale!,5):"Unavailable"}. Candidates are not necessarily accepted.</p>
            <button disabled={!snapshot.rawText} onClick={async()=>{
              try{await navigator.clipboard.writeText(snapshot.rawText??"");setCopyResult("Diagnostic report copied");}
              catch{setCopyResult("Clipboard unavailable; select the report below and copy it manually");}
            }}>Copy diagnostic report</button>
            <span role="status"> {copyResult}</span>
            <details><summary>Plain-text report {fresh?"":"(stale)"}</summary>
              <textarea aria-label="Calibration diagnostic report" readOnly value={snapshot.rawText??""} rows={12} style={{width:"100%"}} />
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
