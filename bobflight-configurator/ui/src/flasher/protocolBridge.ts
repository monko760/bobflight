/**
 * Protocol flasher bind — static exports are preferred; this stays for FlasherPage.
 * SPDX-License-Identifier: Apache-2.0
 */

import { protocolFlasherReady } from "./createFlasher";

/** Resolves true when Protocol createFlasher is available (static import). */
export async function tryBindProtocolFlasher(): Promise<boolean> {
  return protocolFlasherReady();
}
