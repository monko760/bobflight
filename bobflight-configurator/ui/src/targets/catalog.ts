// Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
import raw from './catalog.generated.json';
export type TargetFamily = 'F4' | 'F7' | 'H7';
export const families: readonly TargetFamily[] = ['F4','F7','H7'];
export const catalog = raw;
export function boardsForFamily(family: TargetFamily) {
  const ids = new Set(catalog.mcus.filter(m => m.family === family).map(m => m.id));
  return catalog.boards.filter(b => b.support !== 'host-only' && ids.has(b.mcu));
}
export function mcuForBoard(boardId: string) {
  const board = catalog.boards.find(b => b.id === boardId);
  return board ? catalog.mcus.find(m => m.id === board.mcu) : undefined;
}

/** F4 USB-only diagnostic image profiles, from boards/<id>.yaml with support: diagnostic. */
export interface DiagnosticProfile {
  id: string; display_name: string; mcu: string; mcu_display: string; support_label: string;
  image_profile: 'f405-usb-diagnostic'; build_label: string; artifact_name: string;
  custom: { mcu: string; flash_kib: number; hse_hz: number } | null;
}
export const diagnosticProfiles = (raw as unknown as { diagnostic_profiles: DiagnosticProfile[] }).diagnostic_profiles;
export function diagnosticProfile(boardId: string): DiagnosticProfile | undefined {
  return diagnosticProfiles.find(p => p.id === boardId);
}
/** Main-image boards the local HEX builder can compile (board file has a build_label). */
export function buildableBoard(boardId: string) {
  const board = catalog.boards.find(b => b.id === boardId);
  const mcu = board ? mcuForBoard(boardId) : undefined;
  return board && board.support !== 'host-only' && board.build_label && mcu?.status === 'implemented' ? board : undefined;
}
