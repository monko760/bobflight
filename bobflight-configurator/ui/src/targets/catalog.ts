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
