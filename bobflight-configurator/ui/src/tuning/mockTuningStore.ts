export type RatesConfig={rate_max_roll:number;rate_max_pitch:number;rate_max_yaw:number;rate_expo:number;};
export type PidConfig={pid_roll_p:number;pid_roll_i:number;pid_roll_d:number;pid_pitch_p:number;pid_pitch_i:number;pid_pitch_d:number;pid_yaw_p:number;pid_yaw_i:number;pid_yaw_d:number;min_throttle:number;airmode:number;};
export type FiltersConfig={gyro_lpf_hz:number;dterm_lpf_hz:number;};
export const RATES_DEFAULTS:RatesConfig={rate_max_roll:800,rate_max_pitch:800,rate_max_yaw:800,rate_expo:0.3};
export const PID_DEFAULTS:PidConfig={pid_roll_p:0.002,pid_roll_i:0.001,pid_roll_d:0.00005,pid_pitch_p:0.002,pid_pitch_i:0.001,pid_pitch_d:0.00005,pid_yaw_p:0.002,pid_yaw_i:0.001,pid_yaw_d:0.00005,min_throttle:0.05,airmode:0};
export const FILTERS_DEFAULTS:FiltersConfig={gyro_lpf_hz:320,dterm_lpf_hz:53};
let ratesState={...RATES_DEFAULTS};let pidState={...PID_DEFAULTS};let filtersState={...FILTERS_DEFAULTS};
export function getRates():RatesConfig{return {...ratesState};} export function setRates(next:RatesConfig):void{ratesState={...next};} export function resetRates():RatesConfig{ratesState={...RATES_DEFAULTS};return getRates();}
export function getPid():PidConfig{return {...pidState};} export function setPid(next:PidConfig):void{pidState={...next};} export function resetPid():PidConfig{pidState={...PID_DEFAULTS};return getPid();}
export function getFilters():FiltersConfig{return {...filtersState};} export function setFilters(next:FiltersConfig):void{filtersState={...next};} export function resetFilters():FiltersConfig{filtersState={...FILTERS_DEFAULTS};return getFilters();}
