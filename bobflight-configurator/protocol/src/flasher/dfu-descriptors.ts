/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/** Read-only fallback when WebUSB omits alternate.interfaceName (e.g. Windows).
 * No assumed string index, language, configuration index or flash density.
 * The caller must still validate the returned layout before any DFU operation.
 */
interface DescriptorDevice {
  controlTransferIn(setup: {
    requestType: "standard"; recipient: "device";
    request: number; value: number; index: number;
  }, length: number): Promise<{
    status: string;
    data?: {buffer: ArrayBuffer; byteOffset: number; byteLength: number};
  }>;
}
export async function readDfuInterfaceName(
  device: DescriptorDevice, configurationValue: number, interfaceNumber: number,
  alternateSetting: number, checkCancelled: () => void = () => {},
): Promise<string> {
  const fail = (message: string): never => { throw new Error(message); };
  const u16 = (b: Uint8Array, p: number) => b[p] | (b[p+1] << 8);
  async function read(type: number, index: number, length: number, language = 0): Promise<Uint8Array> {
    checkCancelled();
    const response = await device.controlTransferIn({
      requestType: "standard", recipient: "device", request: 6,
      value: (type << 8) | index, index: language,
    }, length);
    checkCancelled();
    if (response.status !== "ok" || !response.data) fail(`USB descriptor ${type}:${index} returned ${response.status} without usable data`);
    const d = response.data!;
    if (d.byteLength < 2 || d.byteLength > length) fail(`USB descriptor ${type}:${index} has an invalid transfer length`);
    const b = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    if (b[1] !== type || b[0] < 2) fail(`USB descriptor ${type}:${index} has an invalid header`);
    return b;
  }
  try {
    if (!Number.isInteger(configurationValue) || configurationValue < 1 || configurationValue > 255) fail('No valid active USB configuration');
    const dev = await read(1, 0, 18);
    if (dev.length !== 18 || dev[0] !== 18 || dev[17] < 1 || dev[17] > 16) fail('Invalid or unsupported USB device descriptor');
    let selected: {index: number; header: Uint8Array} | undefined;
    for (let index = 0; index < dev[17]; index++) {
      const header = await read(2, index, 9);
      if (header.length !== 9 || header[0] !== 9 || u16(header,2) < 9 || u16(header,2) > 4096 || !header[5]) fail('Invalid or oversized USB configuration descriptor');
      if (header[5] === configurationValue) {
        if (selected) fail('Ambiguous active USB configuration');
        selected = {index, header};
      }
    }
    if (!selected) fail('Active USB configuration not found in descriptors');
    const {index, header} = selected!;
    const total = u16(header,2), config = await read(2, index, total);
    if (config.length !== total || header.some((b,i) => config[i] !== b)) fail('Truncated or inconsistent USB configuration descriptor');
    let stringIndex = 0, matches = 0;
    for (let offset = 9; offset < total;) {
      if (offset+2 > total) fail('Truncated USB descriptor header');
      const length = config[offset], type = config[offset+1];
      if (length < 2 || offset+length > total || type === 2) fail('Malformed nested USB descriptor');
      if (type === 4) {
        if (length !== 9) fail('Malformed USB interface descriptor');
        if (config[offset+2] === interfaceNumber && config[offset+3] === alternateSetting) {
          if (config[offset+5] !== 0xfe || config[offset+6] !== 1 || config[offset+7] !== 2) fail('Selected alternate is not a DFU-mode interface');
          matches++; stringIndex = config[offset+8];
        }
      }
      offset += length;
    }
    if (matches !== 1 || !stringIndex) fail('Missing or ambiguous DFU interface string index');
    const languages = await read(3,0,255);
    if (languages.length !== languages[0] || languages.length < 4 || languages.length % 2) fail('Malformed USB language descriptor');
    const ids: number[] = [];
    for (let i=2; i<languages.length; i+=2) { const id=u16(languages,i); if (id && !ids.includes(id)) ids.push(id); }
    if (!ids.length) fail('USB device advertises no usable string language');
    const language = ids.includes(0x0409) ? 0x0409 : ids[0];
    const text = await read(3,stringIndex,255,language);
    if (text.length !== text[0] || text.length < 4 || text.length % 2) fail('Malformed USB interface string descriptor');
    let name = '';
    for (let i=2; i<text.length; i+=2) name += String.fromCharCode(u16(text,i));
    return name;
  } catch (error) {
    throw new Error(`Cannot read DFU flash-layout descriptor: ${error instanceof Error ? error.message : String(error)}. No erase/program issued.`);
  }
}
