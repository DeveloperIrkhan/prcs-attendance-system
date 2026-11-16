import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  LOGO_FILE,
  ORG_NAME,
  ORG_SHORT,
  SYSTEM_NAME,
} from "./branding";

import type { ReportTable } from "./type";

// A4 landscape, in points
const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 36;
const ROW_H = 18;
/** Employee pages are tighter so a whole month (days + total row) fits on one sheet. */
const EMPLOYEE_ROW_H = 11.5;
const HEAD_H = 28;
const FONT_SIZE = 8.5;

/** Rows stop here on the last page of an employee, to leave room for the signatures. */
const SIGN_TOP = 96;

type PDFPage = ReturnType<PDFDocument["addPage"]>;
type EmbeddedPng = Awaited<ReturnType<PDFDocument["embedPng"]>>;

const RED = rgb(0.6, 0.08, 0.08);
const LIGHT_RED = rgb(0.98, 0.9, 0.9);
const LIGHT_GRAY = rgb(0.965, 0.965, 0.965);
const DARK_TEXT = rgb(0.1, 0.1, 0.1);

/**
 * Load the organization logo from the public directory.
 */
async function loadLogo(): Promise<Uint8Array | null> {
  try {
    const logoPath = path.join(process.cwd(), LOGO_FILE);

    const buffer = await readFile(logoPath);

    return new Uint8Array(buffer);
  } catch (error) {
    console.error("Unable to load PDF logo:", error);
    return null;
  }
}

/**
 * Standard PDF fonts only cover Western characters.
 * Unsupported characters are replaced with "?".
 */
function safe(font: PDFFont, text: string): string {
  let out = "";

  for (const ch of text.replace(/\s+/g, " ")) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }

  return out;
}

/**
 * Fit text inside a specified width.
 */
function fit(
  font: PDFFont,
  text: string,
  width: number,
  size: number,
): string {
  const clean = safe(font, text);

  if (font.widthOfTextAtSize(clean, size) <= width) {
    return clean;
  }

  let cut = clean;

  while (
    cut.length > 1 &&
    font.widthOfTextAtSize(`${cut}...`, size) > width
  ) {
    cut = cut.slice(0, -1);
  }

  return `${cut}...`;
}

/**
 * Draw the main organization letterhead with the report title and subtitle.
 */
function drawLetterhead(
  page: PDFPage,
  logo: EmbeddedPng | null,
  font: PDFFont,
  bold: PDFFont,
  table: ReportTable,
): number {
  let y = PAGE_H - MARGIN;

  const LOGO_SIZE = logo ? 36 : 0;
  const textX = logo ? MARGIN + LOGO_SIZE + 12 : MARGIN;

  // Organization logo
  if (logo) {
    page.drawImage(logo, {
      x: MARGIN,
      y: y - LOGO_SIZE,
      width: LOGO_SIZE,
      height: LOGO_SIZE,
    });
  }

  page.drawText(safe(bold, ORG_NAME), {
    x: textX,
    y: y - 24,
    size: 16,
    font: bold,
    color: RED,
  });

  page.drawText(safe(font, SYSTEM_NAME), {
    x: textX,
    y: y - 42,
    size: 10,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });

  // Report title and the period / employee on the right side above the
  // separator, on the same lines as the organization name and system name.
  const rightWidth = (PAGE_W - MARGIN * 2) / 2;
  const rightEdge = PAGE_W - MARGIN;

  const title = fit(bold, table.title, rightWidth, 15);

  page.drawText(title, {
    x: rightEdge - bold.widthOfTextAtSize(title, 15),
    y: y - 24,
    size: 15,
    font: bold,
    color: DARK_TEXT,
  });

  const subtitle = fit(font, table.subtitle, rightWidth, 10);

  page.drawText(subtitle, {
    x: rightEdge - font.widthOfTextAtSize(subtitle, 10),
    y: y - 42,
    size: 10,
    font,
    color: rgb(0.25, 0.25, 0.25),
  });

  y -= Math.max(LOGO_SIZE, 42) + 8;

  // Separator
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 1.5,
    color: RED,
  });

  return y - 8;
}

/**
 * Draw the report table header.
 */
function drawTableHeader(
  page: ReturnType<PDFDocument["addPage"]>,
  table: ReportTable,
  widths: number[],
  y: number,
  bold: PDFFont,
): number {
  const usable = PAGE_W - MARGIN * 2;

  page.drawRectangle({
    x: MARGIN,
    y: y - HEAD_H + 6,
    width: usable,
    height: HEAD_H,
    color: RED,
  });

  let x = MARGIN;

  table.column.forEach((column, i) => {
    const width = widths[i];
    const clean = safe(bold, column.label);

    const heading =
      bold.widthOfTextAtSize(clean, FONT_SIZE) <= width - 8
        ? [clean]
        : (() => {
            const words = clean.split(" ");

            for (let split = 1; split < words.length; split++) {
              const first = words.slice(0, split).join(" ");
              const second = words.slice(split).join(" ");

              if (
                bold.widthOfTextAtSize(first, FONT_SIZE) <= width - 8 &&
                bold.widthOfTextAtSize(second, FONT_SIZE) <= width - 8
              ) {
                return [first, second];
              }
            }

            return [fit(bold, clean, width - 8, FONT_SIZE)];
          })();

    heading.forEach((text, line) => {
      const textWidth = bold.widthOfTextAtSize(text, FONT_SIZE);

      const tx =
        column.align === "right"
          ? x + width - 4 - textWidth
          : column.align === "center"
            ? x + (width - textWidth) / 2
            : x + 4;

      const ty =
        heading.length === 1
          ? y - 11
          : y - 6 - line * 10;

      page.drawText(text, {
        x: tx,
        y: ty,
        size: FONT_SIZE,
        font: bold,
        color: rgb(1, 1, 1),
      });
    });

    x += width;
  });

  return y - HEAD_H;
}

/**
 * Draw a compact page header (continuation pages and employee pages).
 */
function drawCompactHeader(
  page: PDFPage,
  logo: EmbeddedPng | null,
  font: PDFFont,
  table: ReportTable,
): number {
  let y = PAGE_H - MARGIN;

  if (logo) {
    page.drawImage(logo, {
      x: MARGIN,
      y: y - 18,
      width: 18,
      height: 18,
    });
  }

  const hx = logo ? MARGIN + 24 : MARGIN;

  page.drawText(
    fit(
      font,
      `${ORG_NAME} (${ORG_SHORT}) - ${table.title}`,
      PAGE_W - MARGIN * 2 - 30,
      8.5,
    ),
    {
      x: hx,
      y: y - 12,
      size: 8.5,
      font,
      color: rgb(0.35, 0.35, 0.35),
    },
  );

  y -= 26;

  page.drawText(fit(font, table.subtitle, PAGE_W - MARGIN * 2, 8.5), {
    x: MARGIN,
    y,
    size: 8.5,
    font,
    color: rgb(0.25, 0.25, 0.25),
  });

  return y - 14;
}

/**
 * Draw the employee / HOD signature block at the bottom of an employee page.
 */
function drawSignatureBlock(
  page: PDFPage,
  font: PDFFont,
  bold: PDFFont,
  employeeName: string,
): void {
  const half = (PAGE_W - MARGIN * 2) / 2;
  const leftX = MARGIN + 2;
  const rightX = MARGIN + half + 10;
  const lineWidth = half - 30;

  page.drawText(
    fit(bold, `Employee Name: ${employeeName || "________________"}`, lineWidth, 9),
    {
      x: leftX,
      y: 84,
      size: 9,
      font: bold,
      color: DARK_TEXT,
    },
  );

  page.drawText(safe(bold, "HOD Name:"), {
    x: rightX,
    y: 84,
    size: 9,
    font: bold,
    color: DARK_TEXT,
  });

  page.drawLine({
    start: { x: leftX, y: 66 },
    end: { x: leftX + lineWidth, y: 66 },
    thickness: 0.8,
    color: rgb(0.35, 0.35, 0.35),
  });

  page.drawLine({
    start: { x: rightX, y: 66 },
    end: { x: rightX + lineWidth, y: 66 },
    thickness: 0.8,
    color: rgb(0.35, 0.35, 0.35),
  });

  page.drawText("Signature", {
    x: leftX,
    y: 50,
    size: 8,
    font,
    color: rgb(0.45, 0.45, 0.45),
  });

  page.drawText("Signature", {
    x: rightX,
    y: 50,
    size: 8,
    font,
    color: rgb(0.45, 0.45, 0.45),
  });
}

/**
 * Draw one table row (a day, an employee, a total...).
 */
function drawRow(
  page: PDFPage,
  table: ReportTable,
  widths: number[],
  row: string[],
  y: number,
  rowH: number,
  font: PDFFont,
  bold: PDFFont,
  highlight: boolean,
  alternate: boolean,
): void {
  const usable = PAGE_W - MARGIN * 2;

  const isWeeklyOff = row.some(
    (cell) => String(cell ?? "").trim().toLowerCase() === "weekly off",
  );

  const f = highlight ? bold : font;

  // Background priority: Weekly Off = Red, Total = Green, Alternate = Gray.
  if (isWeeklyOff && !highlight) {
    page.drawRectangle({
      x: MARGIN,
      y: y - rowH + 6,
      width: usable,
      height: rowH,
      color: rgb(1, 0.9, 0.9),
    });
  } else if (highlight) {
    page.drawRectangle({
      x: MARGIN,
      y: y - rowH + 6,
      width: usable,
      height: rowH,
      color: LIGHT_RED,
    });
  } else if (alternate) {
    page.drawRectangle({
      x: MARGIN,
      y: y - rowH + 6,
      width: usable,
      height: rowH,
      color: LIGHT_GRAY,
    });
  }

  let x = MARGIN;

  row.forEach((cell, i) => {
    const width = widths[i] ?? 0;
    const text = fit(f, String(cell ?? ""), width - 8, FONT_SIZE);
    const textWidth = f.widthOfTextAtSize(text, FONT_SIZE);
    const align = table.column[i]?.align;

    const tx =
      align === "right"
        ? x + width - 4 - textWidth
        : align === "center"
          ? x + (width - textWidth) / 2
          : x + 4;

    page.drawText(text, {
      x: tx,
      y: y - rowH + 10,
      size: FONT_SIZE,
      font: f,
      color: DARK_TEXT,
    });

    x += width;
  });
}

/**
 * Render report as landscape A4 PDF.
 */
export async function renderReportPdf(
  table: ReportTable,
  generatedBy: string,
  logoPng?: Uint8Array | null,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Load logo automatically if caller did not provide one.
  const logoBytes = logoPng === undefined ? await loadLogo() : logoPng;

  let logo: Awaited<ReturnType<typeof pdf.embedPng>> | null = null;

  if (logoBytes) {
    try {
      logo = await pdf.embedPng(logoBytes);
    } catch (error) {
      console.error("Unable to embed PDF logo:", error);
    }
  }

  const usable = PAGE_W - MARGIN * 2;

  const totalWeight = table.column.reduce(
    (sum, column) => sum + (column.weight ?? 1),
    0,
  );

  const widths = table.column.map(
    (column) =>
      ((column.weight ?? 1) / totalWeight) * usable,
  );

  const subtotal = new Set(table.subtotalRows ?? []);

  // When the report says which columns identify an employee, every employee
  // gets their own page (and a signature block at the bottom).
  const grouped = Boolean(table.employeePages);
  const signBlocks = grouped || Boolean(table.signatureName);
  const rowH = signBlocks ? EMPLOYEE_ROW_H : ROW_H;

  type Block = {
    name: string;
    items: { row: string[]; index: number }[];
  };

  const blocks: Block[] = [];

  if (table.employeePages) {
    const { key, name } = table.employeePages;
    const byEmployee = new Map<string, Block>();

    table.rows.forEach((row, index) => {
      const id = key.map((i) => String(row[i] ?? "").trim()).join("\u0000");
      let block = byEmployee.get(id);

      if (!block) {
        block = { name: String(row[name] ?? "").trim(), items: [] };
        byEmployee.set(id, block);
      }

      block.items.push({ row, index });
    });

    blocks.push(...byEmployee.values());
  } else {
    blocks.push({
      name: table.signatureName ?? "",
      items: table.rows.map((row, index) => ({ row, index })),
    });
  }

  const pages: PDFPage[] = [];

  let page: PDFPage = pdf.addPage([PAGE_W, PAGE_H]);
  pages.push(page);

  let y = 0;

  const drawHeader = (full: boolean, withTableHeader = true) => {
    y = full
      ? drawLetterhead(page, logo, font, bold, table)
      : drawCompactHeader(page, logo, font, table);

    if (withTableHeader) y = drawTableHeader(page, table, widths, y, bold);
  };

  const newPage = (full = false, withTableHeader = true) => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    drawHeader(full, withTableHeader);
  };

  // --------------------------------------------------
  // EMPLOYEE PAGES
  // --------------------------------------------------

  if (table.rows.length === 0) {
    drawHeader(true);

    page.drawText("No records match these filters.", {
      x: MARGIN + 4,
      y: y - 10,
      size: 10,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });

    y -= rowH;

    if (table.signatureName) {
      drawSignatureBlock(page, font, bold, table.signatureName);
    }
  } else {
    blocks.forEach((block, blockIndex) => {
      if (blockIndex === 0) {
        // The first page keeps the original letterhead and heading style.
        drawHeader(true);
      } else {
        newPage();
      }

      block.items.forEach((item, itemIndex) => {
        const isLast = itemIndex === block.items.length - 1;

        // On the last row of an employee, keep room for the signatures.
        const bottom = signBlocks && isLast ? SIGN_TOP + 6 : MARGIN + 18;

        if (y - rowH < bottom) newPage();

        drawRow(
          page,
          table,
          widths,
          item.row,
          y,
          rowH,
          font,
          bold,
          subtotal.has(item.index),
          itemIndex % 2 === 1,
        );

        y -= rowH;
      });

      if (signBlocks) {
        drawSignatureBlock(page, font, bold, block.name);
      }
    });
  }

  // --------------------------------------------------
  // GRAND TOTAL AND NOTES
  // --------------------------------------------------

  const notes = table.notes ?? [];

  if (grouped) {
    // The grand total cannot sit on one employee's page: it gets its own sheet.
    const showTotals = Boolean(table.totals) && blocks.length > 1;

    if (showTotals) {
      newPage(false, true);

      drawRow(
        page,
        table,
        widths,
        table.totals!,
        y,
        rowH,
        font,
        bold,
        true,
        false,
      );

      y -= rowH + 6;
    } else if (notes.length > 0) {
      // A single employee keeps the notes on the same sheet when they fit
      // above the signature block.
      const needed = notes.length * 18 + 6;

      if (y - needed < SIGN_TOP + 8) newPage(false, false);
    }

    if (showTotals || notes.length > 0) {
      for (const note of notes) {
        if (y - 16 < MARGIN + 18) newPage(false, false);

        y -= 6;

        page.drawText(fit(font, note, usable, 9), {
          x: MARGIN,
          y: y - 8,
          size: 9,
          font,
          color: rgb(0.3, 0.3, 0.3),
        });

        y -= 12;
      }
    }
  } else {
    if (table.totals) {
      if (y - rowH < MARGIN + 18) newPage();

      drawRow(
        page,
        table,
        widths,
        table.totals,
        y,
        rowH,
        font,
        bold,
        true,
        false,
      );

      y -= rowH;
    }

    for (const note of notes) {
      if (y - 16 < MARGIN + 18) newPage(false, false);

      y -= 6;

      page.drawText(fit(font, note, usable, 9), {
        x: MARGIN,
        y: y - 8,
        size: 9,
        font,
        color: rgb(0.3, 0.3, 0.3),
      });

      y -= 12;
    }
  }

  // --------------------------------------------------
  // FOOTER
  // --------------------------------------------------

  const stamp =
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by ${generatedBy}`;

  pages.forEach((p, i) => {
    p.drawText(fit(font, stamp, usable - 80, 8), {
      x: MARGIN,
      y: 20,
      size: 8,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });

    const label = `Page ${i + 1} of ${pages.length}`;

    p.drawText(label, {
      x: PAGE_W - MARGIN - font.widthOfTextAtSize(label, 8),
      y: 20,
      size: 8,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
  });

  return pdf.save();
}