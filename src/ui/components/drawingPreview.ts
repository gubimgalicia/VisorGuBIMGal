/** The box the preview fits a drawing into, in CSS pixels: the panel's width by its frame. */
const PREVIEW_BOX = { width: 320, height: 168 };
/** How thin the drawing's heaviest line may look in the preview. */
const MIN_STROKE_PX = 0.5;

/**
 * Strokes are in drawing units, so a plan of a 20 km road fitted into the preview draws its
 * lines a thousandth of a pixel wide and nothing shows. Widens every stroke and dash by the
 * same factor until the heaviest line is MIN_STROKE_PX; a drawing that already shows is
 * returned as it is.
 */
export function widenForPreview(svg: string, box: { width: number; height: number } = PREVIEW_BOX): string {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1].trim().split(/[\s,]+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || !(viewBox[2] > 0) || !(viewBox[3] > 0)) return svg;
  const pixelsPerUnit = Math.min(box.width / viewBox[2], box.height / viewBox[3]);
  const widths = [...svg.matchAll(/stroke-width="([^"]+)"/g)].map((match) => Number(match[1]));
  const heaviest = Math.max(0, ...widths.filter((width) => Number.isFinite(width)));
  if (heaviest === 0) return svg;
  const scale = MIN_STROKE_PX / (heaviest * pixelsPerUnit);
  if (!(scale > 1)) return svg;
  const widen = (values: string) =>
    values
      .trim()
      .split(/[\s,]+/)
      .map((value) => (Number(value) * scale).toFixed(4))
      .join(' ');
  return svg.replace(/(stroke-width|stroke-dasharray)="([^"]+)"/g, (_, name, values) => `${name}="${widen(values)}"`);
}
