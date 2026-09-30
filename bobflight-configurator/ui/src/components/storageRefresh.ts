/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Pure decision logic for the StoragePanel "Refresh storage" button, kept free
 * of React and the DOM so it can be tested in Node.
 *
 * "Unsaved changes" here is the controller's own storage report
 * (`storage` → dirty=1): settings applied to the FC that are not yet saved to
 * flash. It is the same flag the panel shows as "unsaved changes".
 */
export const REFRESH_CONFIRM_MESSAGE = "Re-read storage status from the FC? Your unsaved changes stay on the FC until you Save.";

export type ConfirmFn = (message: string) => boolean;

/** True only when the controller reports unsaved changes; a clean or unknown snapshot refreshes immediately. */
export function shouldConfirmRefresh(dirty: boolean): boolean {
  return dirty === true;
}

/** Dirty signal for the guard: the latest verified storage snapshot's `dirty` flag (null/unknown = clean). */
export function storageDirty(snapshot: { dirty: boolean } | null | undefined): boolean {
  return snapshot?.dirty === true;
}

/**
 * Ask before reloading when dirty. Cancel keeps everything as-is; confirm (or
 * a clean state) calls `refresh` exactly once. Returns whether refresh ran.
 */
export function requestRefresh({ dirty, confirm, refresh }: { dirty: boolean; confirm: ConfirmFn; refresh: () => void }): boolean {
  if (shouldConfirmRefresh(dirty) && !confirm(REFRESH_CONFIRM_MESSAGE)) return false;
  refresh();
  return true;
}

/** Default browser confirm; returns false where no window exists (never refresh silently past a guard). */
export function browserConfirm(message: string): boolean {
  return typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(message) : false;
}
