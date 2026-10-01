'use strict';
// Render report documents (see services/reports.js) to CSV, Excel and PDF.
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const fmt = require('../lib/format');

const NAVY = '#0f2a4a';
const TEAL = '#0f8b8d';

function headerLines(doc) {
  return [
    doc.title,
    `Reporting period: ${doc.periodLabel}`,
    `Site: ${doc.siteLabel}`,
    ...(doc.filters.length ? [`Filters: ${doc.filters.join('; ')}`] : []),
    `Generated: ${doc.generatedAt} (${doc.timeZone})`,
  ];
}

function kpiText(k) {
  return `${fmt.kpiValue(k)}${k.type === 'pkr' || k.value === null ? '' : ' ' + k.unit}${k.pct !== undefined ? ` (vs prev: ${fmt.pct(k.pct) ?? 'N/A'})` : ''}${k.note ? ` — ${k.note}` : ''}`;
}

// ---------------- CSV ----------------

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV uses raw (unformatted) numbers so values import cleanly into spreadsheets. */
function toCsv(doc) {
  const lines = [];
  const row = (arr) => lines.push(arr.map(csvEscape).join(','));
  for (const l of headerLines(doc)) row([l]);
  row([]);
  row(['Summary']);
  for (const k of doc.kpis) row([k.label, k.value ?? 'N/A', k.unit, k.note || '']);
  for (const s of doc.sections) {
    row([]);
    row([`${s.title}${s.unit ? ` (${s.unit})` : ''}`]);
    row(s.columns.map((c) => c.label));
    if (!s.rows.length) row(['No records']);
    for (const r of s.rows) row(s.columns.map((c) => rawValue(c, r[c.key])));
    if (s.totals) row(s.columns.map((c, i) => (i === 0 ? 'TOTAL' : c.key in s.totals ? rawValue(c, s.totals[c.key]) : '')));
    for (const n of s.notes || []) row([`Note: ${n}`]);
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function rawValue(c, v) {
  if (v === null || v === undefined || v === '') return c.na !== undefined && c.type !== 'text' ? c.na : '';
  if (['num', 'int', 'pkr', 'pct'].includes(c.type)) return v;
  return v;
}

// ---------------- Excel ----------------

async function toXlsx(doc) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Utilities & Maintenance Management System';
  wb.created = new Date();
  const sheetNames = new Set();
  const uniqueName = (n) => {
    let base = n.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Sheet';
    let name = base, i = 2;
    while (sheetNames.has(name)) name = `${base.slice(0, 25)} ${i++}`;
    sheetNames.add(name);
    return name;
  };
  const writeHeader = (ws, width) => {
    headerLines(doc).forEach((l, i) => {
      const r = ws.addRow([l]);
      r.font = i === 0 ? { bold: true, size: 14, color: { argb: 'FF0F2A4A' } } : { size: 10, color: { argb: 'FF475569' } };
      ws.mergeCells(r.number, 1, r.number, Math.max(1, width));
    });
    ws.addRow([]);
  };

  const summary = wb.addWorksheet(uniqueName('Summary'));
  writeHeader(summary, 4);
  const sh = summary.addRow(['Metric', 'Value', 'Unit', 'Note']);
  styleHeader(sh);
  for (const k of doc.kpis) {
    const r = summary.addRow([k.label, k.value ?? 'N/A', k.unit, [k.pct !== undefined ? `vs previous: ${fmt.pct(k.pct) ?? 'N/A'}` : '', k.note || ''].filter(Boolean).join(' · ')]);
    r.getCell(2).numFmt = k.type === 'pkr' ? '#,##0.00' : '#,##0.00';
  }
  summary.columns.forEach((c, i) => { c.width = [32, 18, 10, 40][i]; });

  for (const s of doc.sections) {
    const ws = wb.addWorksheet(uniqueName(s.title.replace(/^Duct cleaning & maintenance — /, 'Maint. ')), { views: [{ state: 'frozen', ySplit: headerLines(doc).length + 3 }] });
    writeHeader(ws, s.columns.length);
    const t = ws.addRow([`${s.title}${s.unit ? ` (${s.unit})` : ''}`]);
    t.font = { bold: true, size: 12, color: { argb: 'FF0F8B8D' } };
    styleHeader(ws.addRow(s.columns.map((c) => c.label)));
    if (!s.rows.length) ws.addRow(['No records']);
    for (const r of s.rows) {
      const row = ws.addRow(s.columns.map((c) => xlsxValue(c, r[c.key])));
      applyFormats(row, s.columns);
    }
    if (s.totals) {
      const tr = ws.addRow(s.columns.map((c, i) => (i === 0 ? 'TOTAL' : c.key in s.totals ? xlsxValue(c, s.totals[c.key]) : null)));
      tr.font = { bold: true };
      tr.eachCell((cell) => { cell.border = { top: { style: 'thin' } }; });
      applyFormats(tr, s.columns);
    }
    for (const n of s.notes || []) ws.addRow([`Note: ${n}`]).font = { italic: true, size: 9, color: { argb: 'FF64748B' } };
    s.columns.forEach((c, i) => { ws.getColumn(i + 1).width = Math.min(45, Math.max(12, c.label.length + 2, ['remarks', 'comparison', 'item_name'].includes(c.key) ? 30 : 0)); });
  }
  return wb.xlsx.writeBuffer();
}

function xlsxValue(c, v) {
  if (v === null || v === undefined || v === '') return c.na !== undefined && c.type !== 'text' ? c.na : null;
  if (c.type === 'date') return fmt.cell(c, v);
  if (c.type === 'datetime') return fmt.cell(c, v);
  if (c.type === 'pct') return v / 100;
  return v;
}

function applyFormats(row, columns) {
  columns.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    if (c.type === 'num') cell.numFmt = c.dp === 0 ? '#,##0' : '#,##0.00';
    if (c.type === 'int') cell.numFmt = '#,##0';
    if (c.type === 'pkr') cell.numFmt = '#,##0.00';
    if (c.type === 'pct') cell.numFmt = '0.0%';
  });
}

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2A4A' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
}

// ---------------- PDF ----------------

function toPdf(doc) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 40, bottom: 45, left: 36, right: 36 }, bufferPages: true,
      info: { Title: doc.title, Author: 'Utilities & Maintenance Management System' } });
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const left = pdf.page.margins.left;
    const width = pdf.page.width - left - pdf.page.margins.right;
    const bottomLimit = () => pdf.page.height - pdf.page.margins.bottom - 10;

    // Title block
    pdf.rect(left, 32, width, 4).fill(TEAL);
    pdf.moveDown(0.6);
    pdf.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text(doc.title, left, 44);
    pdf.font('Helvetica').fontSize(9).fillColor('#334155');
    for (const l of headerLines(doc).slice(1)) pdf.text(l);
    pdf.moveDown(0.6);

    // KPI grid
    const kw = width / 4;
    let ky = pdf.y;
    doc.kpis.forEach((k, i) => {
      const x = left + (i % 4) * kw;
      if (i && i % 4 === 0) ky += 40;
      pdf.roundedRect(x + 2, ky, kw - 4, 36, 3).fillAndStroke('#f1f5f9', '#e2e8f0');
      pdf.fillColor('#64748b').font('Helvetica').fontSize(7.5).text(k.label.toUpperCase(), x + 8, ky + 5, { width: kw - 16 });
      pdf.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text(kpiText(k), x + 8, ky + 17, { width: kw - 16, height: 16, ellipsis: true });
    });
    pdf.y = ky + 48;

    for (const s of doc.sections) drawTable(pdf, s, left, width, bottomLimit);

    // Footer with page numbers
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      const y = pdf.page.height - 30;
      pdf.font('Helvetica').fontSize(7.5).fillColor('#64748b');
      pdf.text(`${doc.title} · ${doc.periodLabel} · ${doc.siteLabel}`, left, y, { width: width / 2, lineBreak: false, height: 10 });
      pdf.text(`Page ${i - range.start + 1} of ${range.count}`, left + width / 2, y, { width: width / 2, align: 'right', lineBreak: false, height: 10 });
    }
    pdf.end();
  });
}

function drawTable(pdf, s, left, width, bottomLimit) {
  const fontSize = s.columns.length > 10 ? 6.5 : 7.5;
  const weights = s.columns.map((c) => (['remarks', 'comparison', 'item_name', 'reason', 'period_label', 'metric', 'flag'].includes(c.key) ? 2.2 : ['site_name', 'name', 'tank_label', 'meter_name', 'generator_name'].includes(c.key) ? 1.5 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / total) * width);
  const isNum = (c) => ['num', 'int', 'pkr', 'pct'].includes(c.type);

  const ensure = (h) => { if (pdf.y + h > bottomLimit()) { pdf.addPage(); pdf.y = pdf.page.margins.top; return true; } return false; };
  const rowHeight = (cells, font) => {
    pdf.font(font).fontSize(fontSize);
    return Math.max(...cells.map((t, i) => pdf.heightOfString(t, { width: widths[i] - 6 }))) + 6;
  };
  const drawRow = (cells, { font = 'Helvetica', fill = null, color = '#0f172a' } = {}) => {
    const h = rowHeight(cells, font);
    const y = pdf.y;
    if (fill) pdf.rect(left, y, width, h).fill(fill);
    let x = left;
    pdf.font(font).fontSize(fontSize).fillColor(color);
    cells.forEach((t, i) => {
      pdf.text(t, x + 3, y + 3, { width: widths[i] - 6, align: isNum(s.columns[i]) ? 'right' : 'left' });
      x += widths[i];
    });
    pdf.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.3).strokeColor('#e2e8f0').stroke();
    pdf.y = y + h;
  };
  const header = s.columns.map((c) => c.label);
  const drawHeader = () => drawRow(header, { font: 'Helvetica-Bold', fill: NAVY, color: '#ffffff' });

  ensure(60);
  pdf.moveDown(0.4);
  pdf.font('Helvetica-Bold').fontSize(11).fillColor(TEAL).text(`${s.title}${s.unit ? ` (${s.unit})` : ''}`, left, pdf.y);
  pdf.moveDown(0.2);
  drawHeader();
  if (!s.rows.length) {
    pdf.font('Helvetica-Oblique').fontSize(fontSize).fillColor('#64748b').text('No records for the selected filters.', left + 3, pdf.y + 3);
    pdf.moveDown(0.5);
  }
  s.rows.forEach((r, idx) => {
    const cells = s.columns.map((c) => fmt.cell(c, r[c.key]));
    if (ensure(rowHeight(cells, 'Helvetica'))) drawHeader();
    drawRow(cells, { fill: idx % 2 ? '#f8fafc' : null });
  });
  if (s.totals) {
    const cells = s.columns.map((c, i) => (i === 0 ? 'TOTAL' : c.key in s.totals ? fmt.cell(c, s.totals[c.key]) : ''));
    if (ensure(rowHeight(cells, 'Helvetica-Bold'))) drawHeader();
    drawRow(cells, { font: 'Helvetica-Bold', fill: '#e6f4f4' });
  }
  for (const n of s.notes || []) {
    ensure(14);
    pdf.font('Helvetica-Oblique').fontSize(7).fillColor('#64748b').text(n, left, pdf.y + 2, { width });
  }
  pdf.moveDown(0.8);
}

module.exports = { toCsv, toXlsx, toPdf };
