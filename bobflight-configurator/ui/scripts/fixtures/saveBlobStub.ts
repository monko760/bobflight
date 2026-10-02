/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Test stub for ../blackbox/saveBlob (swapped in by run-blackbox-download.mjs): records every saved file. */
export interface SavedFile { name: string; blob: Blob }
export function savedFiles(): SavedFile[] {
  const g = globalThis as { __bbSavedFiles?: SavedFile[] };
  return (g.__bbSavedFiles ??= []);
}
export function saveBlobFile(name: string, blob: Blob): void {
  savedFiles().push({ name, blob });
}
