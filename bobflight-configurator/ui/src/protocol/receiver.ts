export type ReceiverMap = "AETR" | "TAER";
export interface ReceiverReading {
  uart: number; map: ReceiverMap; link: "unbound" | "waiting" | "live" | "lost";
  age_ms: number; frames: number; crc_errors: number; stream_resets: number;
  armed: number; bench_active: number; failsafe: number; channels: number[];
}
export function parseReceiver(raw: string): ReceiverReading {
  if (/refused|failed/i.test(raw)) throw new Error(raw.trim());
  const fields: Record<string,string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match=/^([a-z_]+): (.+)$/.exec(line.trim());
    if(match) fields[match[1]]=match[2];
  }
  if (fields.receiver_api!=="1" || fields.receiver_end!=="1" || fields.protocol!=="CRSF" || fields.persistence!=="ram") {
    throw new Error("Receiver diagnostics unavailable. Update the firmware to match this configurator.");
  }
  if (!["AETR","TAER"].includes(fields.map) || !["unbound","waiting","live","lost"].includes(fields.link)) throw new Error("Invalid receiver response.");
  const result: Record<string,unknown>={map:fields.map,link:fields.link};
  for (const key of ["uart","age_ms","frames","crc_errors","stream_resets","armed","bench_active","failsafe"]) {
    if (!/^-?\d+$/.test(fields[key]??"")) throw new Error("Incomplete receiver diagnostics.");
    const n=Number(fields[key]);
    if (!Number.isSafeInteger(n) || n < (key==="age_ms"?-1:0)) throw new Error("Invalid receiver diagnostics.");
    result[key]=n;
  }
  for (const key of ["armed","bench_active","failsafe"]) if(result[key]!==0 && result[key]!==1) throw new Error("Invalid receiver flags.");
  const channels=(fields.channels??"").trim().split(/\s+/).map(Number);
  if (channels.length!==16 || channels.some((v,i)=>!Number.isFinite(v) || v<(i===3?0:-1) || v>1)) throw new Error("Invalid channel readings.");
  if (fields.link==="live" && (Number(result.age_ms)<0 || Number(result.age_ms)>250)) throw new Error("Stale receiver response.");
  result.channels=channels;
  return result as unknown as ReceiverReading;
}
