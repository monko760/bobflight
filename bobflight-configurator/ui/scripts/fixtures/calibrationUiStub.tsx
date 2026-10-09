import type {SensorSnapshot} from '../../src/sensors/telemetry';
export const calls:string[]=[];
export let current:SensorSnapshot;
let failure="";let conditions={fresh:true,connected:true};
export function setFailure(cmd=""){failure=cmd;}
export function setConditions(c:Partial<typeof conditions>={}){conditions={fresh:true,connected:true,...c};}
export function setSnapshot(s:SensorSnapshot){current=s;calls.length=0;}
export function useSensorTelemetry(){return {connected:true,snapshot:current,fresh:true,fps:20,error:null,reply:null,pending:false,oldFirmware:false,propsOff:true,setPropsOff:()=>{},stationary:true,setStationary:()=>{},command:async(s:string)=>{calls.push(s);return s===failure?'set failed':`ok ${s}`;},pollDetailedCalibration:()=>{},...conditions};}
export function StoragePanel(p:{blocked:boolean}){return <section data-storage-blocked={String(p.blocked)}>Save is explicit</section>;}
