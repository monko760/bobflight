// SPDX-License-Identifier: Apache-2.0
export * from '../../src/flasher/index';
export const scenario = { available: true, picks: 0, flashes: 0, cancels: 0,
  pick: async (): Promise<any> => ({vendorId:0x0483,productId:0xdf11,productName:'Test-only DFU'}),
  flash: async (): Promise<void> => {}, kinds: [] as string[] };
export const isWebUsbAvailable = () => scenario.available;
export const webUsbUnavailableReason = () => scenario.available ? '' : 'Test browser has no WebUSB';
export function createFlasher(kind: 'mock' | 'webusb-dfu') {
  scenario.kinds.push(kind);
  return {kind, requestDevice: () => {scenario.picks++; return scenario.pick();},
    flash: () => {scenario.flashes++; return scenario.flash();},
    cancel: () => {scenario.cancels++;}, onProgress: () => () => {}};
}
