import type { LargeFields } from './types';

export function largeField(fields: LargeFields | undefined, column: string) {
  return fields && Object.hasOwn(fields, column) ? fields[column] : undefined;
}

export const CELL_CHUNK = 131072;
export const MAX_EDIT_BYTES = 16 * 1024 * 1024;
export type CellChunk = { value: string | null; offset: number; nextOffset: number; total: number; complete: boolean };
export type ReadCell = (column: string, offset: number, signal: AbortSignal) => Promise<CellChunk>;

// Fetch complete values only on request, in bounded pieces. Never return a
// partial value as a complete copy or as the original for an edit.
export async function fullCell(reader: ReadCell, column: string, signal: AbortSignal): Promise<string> {
  const parts: string[] = [];
  let offset = 0, bytes = 0;
  const encoder = new TextEncoder();
  for (;;) {
    signal.throwIfAborted();
    const part = await reader(column, offset, signal);
    signal.throwIfAborted();
    if (part.offset !== offset || part.value === null || !Number.isSafeInteger(part.total) || part.total < offset || !Number.isSafeInteger(part.nextOffset) || part.nextOffset > part.total || part.nextOffset < offset || part.complete !== (part.nextOffset === part.total) || (!part.complete && part.nextOffset === offset)) throw new Error('Could not read this value completely. Refresh the row and retry.');
    bytes += encoder.encode(part.value).length;
    if (bytes > MAX_EDIT_BYTES || part.total > MAX_EDIT_BYTES) throw new Error('This value exceeds the 16 MiB form/copy limit. Read it in parts or use SQL for larger changes.');
    parts.push(part.value);
    if (part.complete) return parts.join('');
    offset = part.nextOffset;
  }
}
