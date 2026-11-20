// T-166 (C15): minimal zero-dependency vector PDF export tests.
// Verifies PDF 1.4 structure (%PDF-, exact xref offsets, %%EOF), A4/A3 landscape /MediaBox
// dimensions, architectural scaling (1:50, 1:100, 1:200), WinAnsi encoding of m² and Spanish
// accents, and literal string escaping.
// Usage: node --experimental-strip-types test/t166-pdf-export-test.mjs
import assert from 'node:assert/strict';
import {
  inspectPdf,
  PAPER_DIMENSIONS_MM,
  paperSizePt,
  PT_PER_MM,
  svgToPdf
} from '../src/ui/viewer/svgToPdf.ts';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};

const SAMPLE_SVG = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<svg xmlns="http://www.w3.org/2000/svg" width="104.0000mm" height="84.0000mm" viewBox="0 0 10.4000 8.4000">',
  '<g fill="none" stroke="#1a1a1a" stroke-width="0.0100" stroke-linejoin="round">',
  '<path d="M 0.2000 0.2000 L 10.2000 0.2000 L 10.2000 8.2000 L 0.2000 8.2000 Z"/>',
  '</g>',
  '<g fill="none" stroke="#334155" stroke-width="0.0070">',
  '<line x1="0.2000" y1="8.3000" x2="10.2000" y2="8.3000"/>',
  '</g>',
  '<g fill="#334155" stroke="none" font-size="0.2000">',
  '<text x="4.5000" y="4.0000">Salón (A) &amp; B</text>',
  '<text x="4.5000" y="4.2500">69.56 m²</text>',
  '</g>',
  '<g fill="#1a1a1a" stroke="none" font-size="0.2200">',
  '<text x="5.0000" y="8.3500">10.00 m</text>',
  '</g>',
  '</svg>'
].join('\n');

check('A4 landscape PDF has valid header, exact xref table, %%EOF, and A4 MediaBox (297 x 210 mm)', () => {
  const bytes = svgToPdf(SAMPLE_SVG, {
    scale: 100,
    paper: 'A4',
    title: 'building-booleans-plan',
    footerLabel: 'Escala 1:100 · A4 horizontal'
  });
  const info = inspectPdf(bytes);
  assert.equal(info.hasPdfHeader, true, `unexpected header: ${info.header}`);
  assert.equal(info.hasXref, true, 'missing xref');
  assert.equal(info.xrefValid, true, 'xref offsets must match exact object byte positions');
  assert.equal(info.hasEof, true, 'missing %%EOF');
  assert.equal(info.objectCount, 5);
  assert.ok(info.mediaBox, 'missing MediaBox');
  const expected = paperSizePt('A4');
  assert.equal(PAPER_DIMENSIONS_MM.A4.widthMm, 297);
  assert.equal(PAPER_DIMENSIONS_MM.A4.heightMm, 210);
  assert.ok(Math.abs(info.mediaBox[2] - expected.widthPt) < 0.02, `width ${info.mediaBox[2]} vs ${expected.widthPt}`);
  assert.ok(Math.abs(info.mediaBox[3] - expected.heightPt) < 0.02, `height ${info.mediaBox[3]} vs ${expected.heightPt}`);
  assert.ok(info.mediaBox[2] > info.mediaBox[3], 'A4 must be landscape');
});

check('A3 landscape PDF has exact A3 MediaBox (420 x 297 mm)', () => {
  const bytes = svgToPdf(SAMPLE_SVG, { scale: 50, paper: 'A3', title: 'Plano A3' });
  const info = inspectPdf(bytes);
  assert.equal(info.hasPdfHeader, true);
  assert.equal(info.xrefValid, true);
  assert.equal(info.hasEof, true);
  assert.ok(info.mediaBox);
  const expected = paperSizePt('A3');
  assert.equal(PAPER_DIMENSIONS_MM.A3.widthMm, 420);
  assert.equal(PAPER_DIMENSIONS_MM.A3.heightMm, 297);
  assert.ok(Math.abs(info.mediaBox[2] - expected.widthPt) < 0.02);
  assert.ok(Math.abs(info.mediaBox[3] - expected.heightPt) < 0.02);
  assert.ok(info.mediaBox[2] > info.mediaBox[3], 'A3 must be landscape');
});

check('vector geometry scales accurately across 1:50, 1:100 and 1:200', () => {
  // Horizontal segment in SAMPLE_SVG has length 10.00 m (from x=0.2 to x=10.2).
  // Extract the first path's M x0 y0 m x1 y1 l horizontal span in points.
  for (const scale of [50, 100, 200]) {
    const bytes = svgToPdf(SAMPLE_SVG, { scale, paper: 'A3' });
    const { contentStream } = inspectPdf(bytes);
    const m = /([0-9.]+) ([0-9.]+) m\n([0-9.]+) ([0-9.]+) l\n([0-9.]+) ([0-9.]+) l\n([0-9.]+) ([0-9.]+) l\nh\nS/.exec(
      contentStream
    );
    assert.ok(m, `missing closed rectangle path in 1:${scale} stream`);
    const spanPt = Number(m[3]) - Number(m[1]);
    const expectedSpanPt = 10 * (1000 / scale) * PT_PER_MM;
    assert.ok(
      Math.abs(spanPt - expectedSpanPt) < 0.05,
      `1:${scale}: expected 10 m = ${expectedSpanPt.toFixed(2)} pt, got ${spanPt.toFixed(2)} pt`
    );
  }
});

check('WinAnsiEncoding encodes m² and Spanish accents and escapes parentheses cleanly', () => {
  const bytes = svgToPdf(SAMPLE_SVG, { scale: 100, paper: 'A4' });
  const { contentStream } = inspectPdf(bytes);
  // ó = 0xF3 = octal \363; '(' and ')' escaped; '&amp;' unescaped to '&'
  assert.ok(contentStream.includes('(Sal\\363n \\(A\\) & B) Tj'), `unexpected text op:\n${contentStream}`);
  // ² = 0xB2 = octal \262
  assert.ok(contentStream.includes('(69.56 m\\262) Tj'), `missing WinAnsi m²:\n${contentStream}`);
  assert.ok(contentStream.includes('(10.00 m) Tj'), 'missing dimension text');
});

console.log(`\nt166-pdf-export-test: ${passed}/${passed} pass`);
