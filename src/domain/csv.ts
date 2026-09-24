export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\r\n");
}
