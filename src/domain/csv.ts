export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\r\n");
}

/** UTF-8 byte order mark: prefixed to downloaded CSVs so Excel reads them as UTF-8. */
export const CSV_BOM = "﻿";

/**
 * CSV-injection guard: a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return could be run
 * as a formula by a spreadsheet, so it gets a leading `'` and is shown as text. Every other cell is
 * returned unchanged.
 */
export function guardCell(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}
