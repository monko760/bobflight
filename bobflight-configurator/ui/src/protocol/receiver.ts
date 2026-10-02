export type ReceiverMap = "AETR" | "TAER";
export interface ReceiverReading {
  uart: number; map: ReceiverMap; link: "unbound" | "waiting" | "live" | "lost";
  age_ms: number; frames: number; crc_errors: number; stream_resets: number;
  armed: number; bench_active: number; failsafe: number; channels: number[];
  /** CRSF link statistics lines, verbatim from the FC; undefined when the FC omits the key (older firmware). */
  rx_link_stats?: string; rx_link_lq?: string; rx_loss_reason?: string;
}
/** The three link-statistics keys of the `receiver` report (FW #S2). */
export const RECEIVER_LINK_KEYS = ["rx_link_stats", "rx_link_lq", "rx_loss_reason"] as const;
export interface ReceiverLinkView { rx_link_stats: string; rx_link_lq: string; rx_loss_reason: string }
/**
 * Display strings for the link-statistics readout. Tokens are shown verbatim,
 * including tokens this Configurator does not know; a missing key shows
 * "unknown". rx_link_lq is shown verbatim only when it is an integer 0..100 in
 * canonical form or "unavailable"; anything else shows "unknown". No arithmetic.
 */
export function receiverLinkView(r: Pick<ReceiverReading, "rx_link_stats" | "rx_link_lq" | "rx_loss_reason"> | null | undefined): ReceiverLinkView {
  const token = (v: string | undefined) => (v === undefined || v === "" ? "unknown" : v);
  const lq = r?.rx_link_lq;
  return {
    rx_link_stats: token(r?.rx_link_stats),
    rx_link_lq: lq !== undefined && (lq === "unavailable" || /^(?:100|[1-9]?[0-9])$/.test(lq)) ? lq : "unknown",
    rx_loss_reason: token(r?.rx_loss_reason),
  };
}
export function parseReceiver(raw: string): ReceiverReading {
  if (/refused|failed/i.test(raw)) throw new Error(raw.trim());
  const fields: Record<string,string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match=/^([a-z_]+): (.+)$/.exec(line.trim());
    if(match) fields[match[1]]=match[2];
  }
  if (fields.receiver_api!=="1" || fields.receiver_end!=="1" || fields.protocol!=="CRSF" || !["ram","flash","host_sim","unsupported"].includes(fields.persistence)) {
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
  for (const key of RECEIVER_LINK_KEYS) if (fields[key]!==undefined) result[key]=fields[key];
  return result as unknown as ReceiverReading;
}
