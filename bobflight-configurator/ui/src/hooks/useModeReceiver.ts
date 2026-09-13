/* SPDX-License-Identifier: Apache-2.0 */
import {useEffect,useState} from 'react';
import {useHost} from './useHost';
import {parseReceiver,type ReceiverReading} from '../protocol/receiver';

export const auxMicroseconds=(value:number)=>Math.round(1500+value*500);
export function movedAux(previous:number[],next:number[]):number[]{
 return next.slice(4).flatMap((value,i)=>Math.abs(value-previous[i+4])>=0.15?[i+1]:[]);
}

/** Poll only while mounted; the host serializes this read with settings commands. */
export function useModeReceiver(){
 const {host,connectionStatus,postFlashGate}=useHost();
 const connected=connectionStatus==='connected'&&!postFlashGate;
 const [state,setState]=useState<{reading:ReceiverReading|null;changed:number[];error:string}>({reading:null,changed:[],error:''});
 useEffect(()=>{
  let active=true,previous:ReceiverReading|null=null;
  let timer:ReturnType<typeof setTimeout>,expiry:ReturnType<typeof setTimeout>;
  setState({reading:null,changed:[],error:''});
  if(!connected)return;
  async function poll(){
   try{
    const reading=parseReceiver(await host.sendCommand('receiver'));
    if(!active)return;
    const changed=reading.link==='live'&&previous?.link==='live'?movedAux(previous.channels,reading.channels):[];
    previous=reading;
    setState(old=>({reading,changed:reading.link!=='live'?[]:changed.length?changed:old.changed,error:''}));
    clearTimeout(expiry);
    expiry=setTimeout(()=>{previous=null;setState({reading:null,changed:[],error:'Receiver updates stopped.'});},750);
   }catch(e){if(active){previous=null;setState({reading:null,changed:[],error:String(e)});}}
   finally{if(active)timer=setTimeout(poll,200);}
  }
  void poll();
  return()=>{active=false;clearTimeout(timer);clearTimeout(expiry);};
 },[host,connected]);
 return {connected,reading:connected?state.reading:null,changed:connected?state.changed:[],error:connected?state.error:''};
}
