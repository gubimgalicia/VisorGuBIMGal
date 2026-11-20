/**
 * Minimal zero-dependency vector PDF 1.4 generator for 2D plan/section SVGs.
 *
 * Converts the whitelisted SVG subset produced by `cad-slicer` (`svg`, `g`, `path`, `line`,
 * `polyline`, `polygon`, `circle`, `text`, `tspan`) into exact vector paths and Type 1
 * Helvetica text (WinAnsiEncoding) at an architectural scale (1:50, 1:100, 1:200) on A4 or A3
 * landscape paper.
 */

export type PdfScale = 50 | 100 | 200;
export type PdfPaper = 'A4' | 'A3';

export const PDF_SCALES: readonly PdfScale[] = [50, 100, 200];
export const PDF_PAPERS: readonly PdfPaper[] = ['A4', 'A3'];

/** Landscape ISO 216 sheet sizes in millimetres. */
export const PAPER_DIMENSIONS_MM: Record<PdfPaper, { widthMm: number; heightMm: number }> = {
  A4: { widthMm: 297, heightMm: 210 },
  A3: { widthMm: 420, heightMm: 297 }
};

export const PT_PER_MM = 72 / 25.4;

export function paperSizePt(paper: PdfPaper): { widthPt: number; heightPt: number } {
  const { widthMm, heightMm } = PAPER_DIMENSIONS_MM[paper];
  return {
    widthPt: widthMm * PT_PER_MM,
    heightPt: heightMm * PT_PER_MM
  };
}

export interface SvgToPdfOptions {
  scale: PdfScale;
  paper: PdfPaper;
  /** Optional sheet title printed in the lower-left of the frame footer. */
  title?: string;
  /** Optional footer scale/paper label printed in the lower-right of the frame footer. */
  footerLabel?: string;
  /** Metres per SVG viewBox unit (default 1, matching `exportDrawing({ units: 'm' })`). */
  metresPerUnit?: number;
}

export interface PdfInspection {
  header: string;
  hasPdfHeader: boolean;
  hasXref: boolean;
  xrefValid: boolean;
  hasEof: boolean;
  mediaBox: [number, number, number, number] | null;
  objectCount: number;
  contentStream: string;
}

interface StyleState {
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeLinejoin: string;
  strokeDasharray: number[];
  fontSize: number;
}

const DEFAULT_STYLE: StyleState = {
  fill: 'none',
  stroke: '#1a1a1a',
  strokeWidth: 0.01,
  strokeLinejoin: 'miter',
  strokeDasharray: [],
  fontSize: 0.2
};

const CP1252_EXTRAS: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f
};

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.abs(n) < 1e-6 ? 0 : n;
  return Number(rounded.toFixed(3)).toString();
}

function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Encodes text as a PDF literal string using WinAnsiEncoding (with octal escapes for >= 0x80). */
function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x3f;
    let byte: number;
    if (code >= 0x20 && code <= 0x7e) {
      byte = code;
    } else if (code >= 0xa0 && code <= 0xff) {
      byte = code;
    } else if (code in CP1252_EXTRAS) {
      byte = CP1252_EXTRAS[code];
    } else if (code === 0x09 || code === 0x0a || code === 0x0d) {
      byte = 0x20;
    } else {
      byte = 0x3f; // '?'
    }

    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) {
      out += '\\' + String.fromCharCode(byte);
    } else if (byte >= 0x20 && byte <= 0x7e) {
      out += String.fromCharCode(byte);
    } else {
      out += '\\' + byte.toString(8).padStart(3, '0');
    }
  }
  out += ')';
  return out;
}

function parseColor(raw: string): [number, number, number] | null {
  const s = raw.trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent') return null;
  if (s === 'black') return [0, 0, 0];
  if (s === 'white') return [1, 1, 1];
  const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (hex3) {
    return [
      parseInt(hex3[1] + hex3[1], 16) / 255,
      parseInt(hex3[2] + hex3[2], 16) / 255,
      parseInt(hex3[3] + hex3[3], 16) / 255
    ];
  }
  const hex6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(s);
  if (hex6) {
    return [
      parseInt(hex6[1], 16) / 255,
      parseInt(hex6[2], 16) / 255,
      parseInt(hex6[3], 16) / 255
    ];
  }
  return null;
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) {
    attrs[m[1]] = unescapeXml(m[2]);
  }
  return attrs;
}

function applyStyle(parent: StyleState, attrs: Record<string, string>): StyleState {
  const next: StyleState = {
    ...parent,
    strokeDasharray: parent.strokeDasharray
  };
  if (attrs.fill !== undefined) next.fill = attrs.fill;
  if (attrs.stroke !== undefined) next.stroke = attrs.stroke;
  if (attrs['stroke-width'] !== undefined) {
    const w = parseFloat(attrs['stroke-width']);
    if (Number.isFinite(w) && w >= 0) next.strokeWidth = w;
  }
  if (attrs['stroke-linejoin'] !== undefined) {
    next.strokeLinejoin = attrs['stroke-linejoin'];
  }
  if (attrs['stroke-dasharray'] !== undefined) {
    const raw = attrs['stroke-dasharray'].trim();
    if (raw === '' || raw === 'none') {
      next.strokeDasharray = [];
    } else {
      next.strokeDasharray = raw
        .split(/[\s,]+/)
        .map(Number)
        .filter((v) => Number.isFinite(v) && v > 0);
    }
  }
  if (attrs['font-size'] !== undefined) {
    const fs = parseFloat(attrs['font-size']);
    if (Number.isFinite(fs) && fs > 0) next.fontSize = fs;
  }
  return next;
}

function parseViewBox(svgText: string): [number, number, number, number] {
  const vbMatch = /\bviewBox\s*=\s*"([^"]+)"/.exec(svgText);
  if (vbMatch) {
    const nums = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    if (nums.length === 4 && nums.every(Number.isFinite) && nums[2] > 0 && nums[3] > 0) {
      return [nums[0], nums[1], nums[2], nums[3]];
    }
  }
  return [0, 0, 10, 10];
}

function paintOperator(style: StyleState): { op: string; setup: string[] } | null {
  const strokeRgb = parseColor(style.stroke);
  const fillRgb = parseColor(style.fill);
  if (!strokeRgb && !fillRgb) return null;
  const setup: string[] = [];
  if (strokeRgb) {
    setup.push(`${fmt(strokeRgb[0])} ${fmt(strokeRgb[1])} ${fmt(strokeRgb[2])} RG`);
  }
  if (fillRgb) {
    setup.push(`${fmt(fillRgb[0])} ${fmt(fillRgb[1])} ${fmt(fillRgb[2])} rg`);
  }
  const op = strokeRgb && fillRgb ? 'B' : strokeRgb ? 'S' : 'f';
  return { op, setup };
}

function emitStrokeState(ops: string[], style: StyleState, ptPerUnit: number): void {
  const widthPt = Math.max(0.25, style.strokeWidth * ptPerUnit);
  ops.push(`${fmt(widthPt)} w`);
  ops.push(style.strokeLinejoin === 'round' ? '1 j 1 J' : '0 j 0 J');
  if (style.strokeDasharray.length > 0) {
    const dashes = style.strokeDasharray.map((d) => fmt(Math.max(0.5, d * ptPerUnit))).join(' ');
    ops.push(`[${dashes}] 0 d`);
  } else {
    ops.push('[] 0 d');
  }
}

function emitPathData(
  ops: string[],
  d: string,
  mapX: (x: number) => number,
  mapY: (y: number) => number,
  paintOp: string
): void {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens || tokens.length === 0) return;

  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let hasSubpath = false;

  const nextNum = (): number => {
    const n = parseFloat(tokens[i++]);
    return Number.isFinite(n) ? n : 0;
  };

  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === 'Z' || cmd === 'z') {
        if (hasSubpath) {
          ops.push('h');
          cx = sx;
          cy = sy;
        }
        continue;
      }
    }

    switch (cmd) {
      case 'M': {
        cx = nextNum();
        cy = nextNum();
        sx = cx;
        sy = cy;
        ops.push(`${fmt(mapX(cx))} ${fmt(mapY(cy))} m`);
        hasSubpath = true;
        cmd = 'L';
        break;
      }
      case 'm': {
        cx += nextNum();
        cy += nextNum();
        sx = cx;
        sy = cy;
        ops.push(`${fmt(mapX(cx))} ${fmt(mapY(cy))} m`);
        hasSubpath = true;
        cmd = 'l';
        break;
      }
      case 'L': {
        cx = nextNum();
        cy = nextNum();
        ops.push(`${fmt(mapX(cx))} ${fmt(mapY(cy))} l`);
        hasSubpath = true;
        break;
      }
      case 'l': {
        cx += nextNum();
        cy += nextNum();
        ops.push(`${fmt(mapX(cx))} ${fmt(mapY(cy))} l`);
        hasSubpath = true;
        break;
      }
      case 'H': {
        cx = nextNum();
        ops.push(`${fmt(mapX(cx))} ${fmt(mapY(cy))} l`);
        hasSubpath = true;
        break;
      }
      case 'h': {
        cx += nextNum();
        ops.push(`${fmt(mapX(cx))} ${fmt(mapY(cy))} l`);
        hasSubpath = true;
        break;
      }
      case 'V': {
        cy = nextNum();
        ops.push(`${fmt(mapX(cx))} ${fmt(mapY(cy))} l`);
        hasSubpath = true;
        break;
      }
      case 'v': {
        cy += nextNum();
        ops.push(`${fmt(mapX(cx))} ${fmt(mapY(cy))} l`);
        hasSubpath = true;
        break;
      }
      default: {
        // Unsupported path command token: advance safely to avoid infinite loops.
        i++;
        break;
      }
    }
  }

  if (hasSubpath) {
    ops.push(paintOp);
  }
}

/** Converts an SVG drawing (in metres by default) into a single-page landscape vector PDF 1.4. */
export function svgToPdf(svgText: string, options: SvgToPdfOptions): Uint8Array {
  const { widthPt: pageW, heightPt: pageH } = paperSizePt(options.paper);
  const metresPerUnit = options.metresPerUnit ?? 1;
  // At 1:scale, 1 real metre is (1000 / scale) mm on paper.
  const ptPerUnit = metresPerUnit * (1000 / options.scale) * PT_PER_MM;

  const [vx, vy, vw, vh] = parseViewBox(svgText);

  const marginPt = 10 * PT_PER_MM;
  const footerPt = 8 * PT_PER_MM;
  const frameX = marginPt;
  const frameY = marginPt + footerPt;
  const frameW = pageW - 2 * marginPt;
  const frameH = pageH - 2 * marginPt - footerPt;

  const drawW = vw * ptPerUnit;
  const drawH = vh * ptPerUnit;
  const originX = frameX + (frameW - drawW) / 2;
  const originY = frameY + (frameH - drawH) / 2;

  const mapX = (x: number) => originX + (x - vx) * ptPerUnit;
  const mapY = (y: number) => originY + (vh - (y - vy)) * ptPerUnit;

  const ops: string[] = [];

  // White page background & clean frame border.
  ops.push('q');
  ops.push('0.2 0.25 0.33 RG');
  ops.push('0.5 w');
  ops.push(`${fmt(frameX)} ${fmt(marginPt)} ${fmt(frameW)} ${fmt(pageH - 2 * marginPt)} re S`);
  ops.push(`${fmt(frameX)} ${fmt(frameY)} m ${fmt(frameX + frameW)} ${fmt(frameY)} l S`);
  ops.push('Q');

  // Footer text (title on the left, scale + paper on the right).
  const footerFontPt = 8;
  const footerTextY = marginPt + (footerPt - footerFontPt) / 2 + 1.5;
  const titleText = (options.title ?? 'guBIM').trim();
  const rightLabel = (options.footerLabel ?? `1:${options.scale} - ${options.paper}`).trim();
  ops.push('q');
  ops.push('0.15 0.19 0.25 rg');
  if (titleText.length > 0) {
    ops.push(`BT /F1 ${fmt(footerFontPt)} Tf ${fmt(frameX + 6)} ${fmt(footerTextY)} Td ${pdfString(titleText)} Tj ET`);
  }
  const approxRightWidth = rightLabel.length * footerFontPt * 0.52;
  const rightX = Math.max(frameX + frameW / 2, frameX + frameW - approxRightWidth - 6);
  ops.push(`BT /F1 ${fmt(footerFontPt)} Tf ${fmt(rightX)} ${fmt(footerTextY)} Td ${pdfString(rightLabel)} Tj ET`);
  ops.push('Q');

  // Clipped drawing viewport.
  ops.push('q');
  ops.push(`${fmt(frameX)} ${fmt(frameY)} ${fmt(frameW)} ${fmt(frameH)} re W n`);

  const stack: StyleState[] = [{ ...DEFAULT_STYLE }];
  const currentStyle = () => stack[stack.length - 1];

  // Match XML elements in order: <text ...>...</text>, closing tags </g>, or opening/self-closing tags.
  const tokenRe =
    /<text\b([^>]*)>([\s\S]*?)<\/text>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)>/g;

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(svgText)) !== null) {
    if (match[2] !== undefined) {
      // <text ...>body</text>
      const attrs = parseAttributes(match[1] ?? '');
      const style = applyStyle(currentStyle(), attrs);
      const fillRgb = parseColor(style.fill) ?? [0.1, 0.1, 0.1];
      const x = parseFloat(attrs.x ?? '0');
      const y = parseFloat(attrs.y ?? '0');
      const rawBody = match[2].replace(/<[^>]+>/g, '');
      const text = unescapeXml(rawBody).trim();
      if (text.length > 0 && Number.isFinite(x) && Number.isFinite(y)) {
        const fontPt = Math.max(3, style.fontSize * ptPerUnit);
        ops.push(`${fmt(fillRgb[0])} ${fmt(fillRgb[1])} ${fmt(fillRgb[2])} rg`);
        ops.push(`BT /F1 ${fmt(fontPt)} Tf ${fmt(mapX(x))} ${fmt(mapY(y))} Td ${pdfString(text)} Tj ET`);
      }
      continue;
    }

    if (match[3] !== undefined) {
      // Closing tag
      const closeTag = match[3].toLowerCase();
      if ((closeTag === 'g' || closeTag === 'svg') && stack.length > 1) {
        stack.pop();
      }
      continue;
    }

    const tag = (match[4] ?? '').toLowerCase();
    const attrs = parseAttributes(match[5] ?? '');
    const selfClosing = match[6] === '/';

    if (tag === 'svg' || tag === 'g') {
      if (!selfClosing) {
        stack.push(applyStyle(currentStyle(), attrs));
      }
      continue;
    }

    const style = applyStyle(currentStyle(), attrs);
    const paint = paintOperator(style);
    if (!paint) continue;

    if (tag === 'path' && attrs.d) {
      ops.push(...paint.setup);
      if (paint.op === 'S' || paint.op === 'B') emitStrokeState(ops, style, ptPerUnit);
      emitPathData(ops, attrs.d, mapX, mapY, paint.op);
    } else if (tag === 'line') {
      const x1 = parseFloat(attrs.x1 ?? 'NaN');
      const y1 = parseFloat(attrs.y1 ?? 'NaN');
      const x2 = parseFloat(attrs.x2 ?? 'NaN');
      const y2 = parseFloat(attrs.y2 ?? 'NaN');
      if ([x1, y1, x2, y2].every(Number.isFinite)) {
        ops.push(...paint.setup);
        emitStrokeState(ops, style, ptPerUnit);
        ops.push(`${fmt(mapX(x1))} ${fmt(mapY(y1))} m ${fmt(mapX(x2))} ${fmt(mapY(y2))} l S`);
      }
    } else if ((tag === 'polyline' || tag === 'polygon') && attrs.points) {
      const coords = attrs.points
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter(Number.isFinite);
      if (coords.length >= 4) {
        ops.push(...paint.setup);
        if (paint.op === 'S' || paint.op === 'B') emitStrokeState(ops, style, ptPerUnit);
        ops.push(`${fmt(mapX(coords[0]))} ${fmt(mapY(coords[1]))} m`);
        for (let k = 2; k + 1 < coords.length; k += 2) {
          ops.push(`${fmt(mapX(coords[k]))} ${fmt(mapY(coords[k + 1]))} l`);
        }
        if (tag === 'polygon') ops.push('h');
        ops.push(paint.op);
      }
    } else if (tag === 'circle') {
      const cx = parseFloat(attrs.cx ?? 'NaN');
      const cy = parseFloat(attrs.cy ?? 'NaN');
      const r = parseFloat(attrs.r ?? 'NaN');
      if ([cx, cy, r].every(Number.isFinite) && r > 0) {
        const px = mapX(cx);
        const py = mapY(cy);
        const pr = r * ptPerUnit;
        const k = pr * 0.5522847498;
        ops.push(...paint.setup);
        if (paint.op === 'S' || paint.op === 'B') emitStrokeState(ops, style, ptPerUnit);
        ops.push(`${fmt(px + pr)} ${fmt(py)} m`);
        ops.push(`${fmt(px + pr)} ${fmt(py + k)} ${fmt(px + k)} ${fmt(py + pr)} ${fmt(px)} ${fmt(py + pr)} c`);
        ops.push(`${fmt(px - k)} ${fmt(py + pr)} ${fmt(px - pr)} ${fmt(py + k)} ${fmt(px - pr)} ${fmt(py)} c`);
        ops.push(`${fmt(px - pr)} ${fmt(py - k)} ${fmt(px - k)} ${fmt(py - pr)} ${fmt(px)} ${fmt(py - pr)} c`);
        ops.push(`${fmt(px + k)} ${fmt(py - pr)} ${fmt(px + pr)} ${fmt(py - k)} ${fmt(px + pr)} ${fmt(py)} c`);
        ops.push(`h ${paint.op}`);
      }
    }
  }

  ops.push('Q');

  const contentStream = ops.join('\n') + '\n';
  return assemblePdf(pageW, pageH, contentStream);
}

function assemblePdf(pageW: number, pageH: number, contentStream: string): Uint8Array {
  const encoder = new TextEncoder();
  const contentBytes = encoder.encode(contentStream);

  const chunks: Uint8Array[] = [];
  let offset = 0;

  const pushBytes = (bytes: Uint8Array) => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const pushAscii = (text: string) => pushBytes(encoder.encode(text));

  // PDF 1.4 header + binary marker comment.
  pushAscii('%PDF-1.4\n');
  pushBytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const objects: Array<() => void> = [
    () => pushAscii('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
    () => pushAscii('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
    () =>
      pushAscii(
        `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(pageW)} ${fmt(pageH)}] ` +
          `/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`
      ),
    () =>
      pushAscii(
        '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n'
      ),
    () => {
      pushAscii(`5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
      pushBytes(contentBytes);
      pushAscii('endstream\nendobj\n');
    }
  ];

  const offsets: number[] = [];
  for (const writeObj of objects) {
    offsets.push(offset);
    writeObj();
  }

  const xrefOffset = offset;
  pushAscii(`xref\n0 ${objects.length + 1}\n`);
  pushAscii('0000000000 65535 f \r\n');
  for (const objOffset of offsets) {
    pushAscii(`${String(objOffset).padStart(10, '0')} 00000 n \r\n`);
  }
  pushAscii(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/** Basic structural parser for verifying generated PDFs in tests without external dependencies. */
export function inspectPdf(bytes: Uint8Array): PdfInspection {
  const text = new TextDecoder('latin1').decode(bytes);
  const firstLineEnd = text.indexOf('\n');
  const header = firstLineEnd >= 0 ? text.slice(0, firstLineEnd).trim() : text.trim();
  const hasPdfHeader = /^%PDF-1\.[0-7]$/.test(header);
  const hasEof = text.trimEnd().endsWith('%%EOF');

  const startXrefMatch = /startxref\s+(\d+)\s+%%EOF/.exec(text);
  let hasXref = false;
  let xrefValid = false;
  let objectCount = 0;

  if (startXrefMatch) {
    const xrefOffset = Number(startXrefMatch[1]);
    if (text.slice(xrefOffset, xrefOffset + 4) === 'xref') {
      hasXref = true;
      const xrefTail = text.slice(xrefOffset);
      const countMatch = /^xref\r?\n0 (\d+)\r?\n/.exec(xrefTail);
      if (countMatch) {
        const size = Number(countMatch[1]);
        objectCount = size - 1;
        const entryRe = /^(\d{10}) (\d{5}) ([fn]) \r?\n/gm;
        const lines = xrefTail.slice(countMatch[0].length);
        let valid = true;
        let seen = 0;
        let em: RegExpExecArray | null;
        while ((em = entryRe.exec(lines)) !== null && seen < size) {
          const pos = Number(em[1]);
          const flag = em[3];
          if (seen === 0) {
            if (flag !== 'f') valid = false;
          } else {
            if (flag !== 'n' || !text.slice(pos).startsWith(`${seen} 0 obj`)) {
              valid = false;
            }
          }
          seen++;
        }
        xrefValid = valid && seen === size && size > 1;
      }
    }
  }

  let mediaBox: [number, number, number, number] | null = null;
  const mbMatch = /\/MediaBox\s*\[\s*([-0-9.]+)\s+([-0-9.]+)\s+([-0-9.]+)\s+([-0-9.]+)\s*\]/.exec(text);
  if (mbMatch) {
    mediaBox = [Number(mbMatch[1]), Number(mbMatch[2]), Number(mbMatch[3]), Number(mbMatch[4])];
  }

  const streamMatch = /stream\r?\n([\s\S]*?)endstream/.exec(text);
  const contentStream = streamMatch ? streamMatch[1] : '';

  return {
    header,
    hasPdfHeader,
    hasXref,
    xrefValid,
    hasEof,
    mediaBox,
    objectCount,
    contentStream
  };
}
