/* SPDX-License-Identifier: Apache-2.0. Original expression of published Actual rates semantics. */
import {validateSettingValue} from '../protocol';
import {RATE_KEYS,type RateKey} from './mockSettingsApi';
import {RATES_DEFAULTS,type RatesConfig} from './mockTuningStore';
export const AXES=['roll','pitch','yaw'] as const;
export function actualRate(x:number,center:number,max:number,expo:number):number{
 if(![x,center,max,expo].every(Number.isFinite)||center<0||center>2000||max<10||max>2000||expo<0||expo>1)return 0;
 const s=Math.min(1,Math.max(-1,x)),a=Math.abs(s),a2=a*a;
 return s*(center+Math.max(0,max-center)*a*(1-expo+expo*a2*a2));
}
export function conditionedStick(x:number):number{
 if(!Number.isFinite(x))return 0;
 const a=Math.min(1,Math.abs(x));return a<=.02?0:Math.sign(x)*(a-.02)/.98;
}
export function rateAtStick(v:RatesConfig,axis:typeof AXES[number],raw:number):number{
 const x=conditionedStick(raw);
 return actualRate(x,v[`rate_center_${axis}`],v[`rate_max_${axis}`],v[`rate_expo_${axis}`]);
}
export function rateDraftValid(v:RatesConfig):boolean{return RATE_KEYS.every(k=>validateSettingValue(k,v[k]));}
export function readRateSettings(all:Record<string,string>):{values:RatesConfig}{
 const values={...RATES_DEFAULTS};
 for(const k of RATE_KEYS){
  if(all[k]===undefined||all[k].trim()===''||!validateSettingValue(k,Number(all[k])))throw Error(`Fresh-install Actual firmware required: missing or invalid ${k}`);
  values[k]=Number(all[k]);
 }
 return {values};
}
/** Nine independent settings only; never reset other configuration. */
export function rateSaveEntries(v:RatesConfig):[RateKey,string][]{
 if(!rateDraftValid(v))throw Error('Invalid Actual rate profile');
 return RATE_KEYS.map(k=>[k,String(v[k])]);
}
