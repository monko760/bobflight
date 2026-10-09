import type {SensorSnapshot} from '../../src/sensors/telemetry';
export const calls:string[]=[];
export let current:SensorSnapshot;
export function setSnapshot(s:SensorSnapshot){current=s;calls.length=0;}
export function useSensorTelemetry(){return {connected:true,snapshot:current,fresh:true,fps:20,error:null,reply:null,pending:false,oldFirmware:false,propsOff:true,setPropsOff:()=>{},stationary:true,setStationary:()=>{},command:async(s:string)=>{calls.push(s);return 'accepted';},pollDetailedCalibration:()=>{}};}
export function StoragePanel(p:{blocked:boolean}){return <section data-storage-blocked={String(p.blocked)}>Save is explicit</section>;}
