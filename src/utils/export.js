import ExcelJS from "exceljs";

/**
 * Tabular exports for the admin panel (TRD 6.3 "export user and driver data (CSV, Excel)").
 * `columns` = [{ key, label, width? }], `rows` = plain objects.
 */

/**
 * Spreadsheet formula injection guard (OWASP "CSV injection"): a cell starting with = + - @
 * (or a tab / carriage return) is executed as a formula by Excel / Sheets, so it is prefixed
 * with an apostrophe and read as text. Applies to strings only — real numbers stay numbers.
 */
export function neutralizeFormula(value) {
  if (typeof value !== "string") return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function cellText(value) {
  if (value == null) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** RFC 4180 field: quoted when it holds a comma, quote, CR or LF; quotes doubled. */
export function csvField(value) {
  const text = typeof value === "string" ? neutralizeFormula(value) : cellText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV document (CRLF line breaks per RFC 4180, UTF-8 BOM so Excel reads accents). */
export function toCsv(columns, rows) {
  const lines = [columns.map((c) => csvField(c.label)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvField(normalize(row[c.key]))).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

function normalize(value) {
  if (value instanceof Date || value == null || typeof value === "number" || typeof value === "boolean") {
    return value instanceof Date ? cellText(value) : value ?? "";
  }
  return cellText(value);
}

/** .xlsx workbook buffer: one sheet, bold header row, frozen header, formula-safe strings. */
export async function toXlsx(columns, rows, sheetName = "Export") {
  const wb = new ExcelJS.Workbook();
  wb.creator = "RideRite Admin";
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: c.width || Math.max(12, c.label.length + 2) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) {
    const out = {};
    for (const c of columns) {
      const v = row[c.key];
      out[c.key] =
        v instanceof Date || typeof v === "number" || typeof v === "boolean" || v == null
          ? v ?? ""
          : neutralizeFormula(cellText(v));
    }
    ws.addRow(out);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Send rows as CSV or XLSX (`format`), with a dated filename. */
export async function sendExport(res, { format, name, columns, rows }) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "xlsx") {
    const buf = await toXlsx(columns, rows, name);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}-${stamp}.xlsx"`);
    return res.send(buf);
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}-${stamp}.csv"`);
  return res.send(toCsv(columns, rows));
}
