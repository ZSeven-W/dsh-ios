import assert from 'node:assert/strict';
import {probeUsbmuxDevicePort,UsbmuxConnectError} from '../lib/usbmux.js';
let closed=0,connects=0;
const resolveDevice=async()=>7;
assert.equal(await probeUsbmuxDevicePort('TEST-DEVICE',8100,{resolveDevice,connectDevice:async(id,port)=>{
  assert.equal(id,7);assert.equal(port,8100);connects++;return {destroy(){closed++;}};
}}),true);
assert.equal(connects,1);assert.equal(closed,1);
assert.equal(await probeUsbmuxDevicePort('TEST-DEVICE',8100,{resolveDevice,connectDevice:async()=>{throw new UsbmuxConnectError(3,'refused');}}),false);
for(const error of [new UsbmuxConnectError(2,'device gone'),new UsbmuxConnectError(6,'bad protocol'),new Error('transport lost')]){
 await assert.rejects(probeUsbmuxDevicePort('TEST-DEVICE',8100,{resolveDevice,connectDevice:async()=>{throw error;}}));
}
await assert.rejects(probeUsbmuxDevicePort('TEST-DEVICE',8100,{resolveDevice:async()=>undefined,connectDevice:async()=>{throw new Error('must not connect');}}),/attached USB/);
await assert.rejects(probeUsbmuxDevicePort('TEST-DEVICE',0,{resolveDevice}),/invalid device port/);
console.log('PASS device listener probe: occupied connection closed; only explicit refusal means absent; missing USB and transport failures stay errors');
