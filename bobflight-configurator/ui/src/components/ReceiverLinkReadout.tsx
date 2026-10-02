/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
import { receiverLinkView, type ReceiverReading } from "../protocol/receiver";

/**
 * CRSF link statistics from the `receiver` report, verbatim. A missing key (or
 * no current reply) shows "unknown"; unknown future tokens are shown as sent.
 * Read-only: nothing here feeds the storage panel or any setter.
 */
export function ReceiverLinkReadout({ reading }: { reading: ReceiverReading | null }) {
  const v = receiverLinkView(reading);
  return <table aria-label="CRSF link statistics"><tbody>
    <tr><th scope="row">Link statistics (rx_link_stats)</th><td><code data-rx-link="rx_link_stats">{v.rx_link_stats}</code></td></tr>
    <tr><th scope="row">Uplink link quality, % (rx_link_lq)</th><td><code data-rx-link="rx_link_lq">{v.rx_link_lq}</code></td></tr>
    <tr><th scope="row">Loss reason (rx_loss_reason)</th><td><code data-rx-link="rx_loss_reason">{v.rx_loss_reason}</code></td></tr>
  </tbody></table>;
}
