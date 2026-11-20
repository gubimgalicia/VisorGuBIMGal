import type { ElementDetails } from '../../domain/kernel/KernelPort';
import type {
  AttributeValue,
  MaterialInfo,
  ModelId,
  PropertySetItem
} from '../../domain/models/ModelRecord';
import { getIntlLocale, t } from '../i18n';

export type ColorByMode = 'none' | 'class' | 'storey' | 'material' | 'property';

export interface ColorableElement {
  modelId: ModelId;
  modelName: string;
  expressId: number;
  ifcClass: string;
  name: string;
  storey: string;
  details?: ElementDetails | null;
}

export interface ColorLegendItem {
  label: string;
  hex: string;
  rgba: number;
  count: number;
}

export interface ColorSchemeResult {
  legend: ColorLegendItem[];
  colorsByModel: Map<ModelId, Map<number, number>>;
}

export const CATEGORY_PALETTE: readonly string[] = [
  '#38bdf8', // sky
  '#f97316', // orange
  '#4ade80', // green
  '#a855f7', // purple
  '#facc15', // yellow
  '#ec4899', // pink
  '#14b8a6', // teal
  '#ef4444', // red
  '#6366f1', // indigo
  '#84cc16', // lime
  '#06b6d4', // cyan
  '#f59e0b'  // amber
];

export const FALLBACK_HEX = '#64748b';

function getFallbackLabels(): Set<string> {
  return new Set([
    t('colorBy.noValue'),
    t('colorBy.noMaterial'),
    t('colorBy.noStorey'),
    t('colorBy.noClass')
  ]);
}

/**
 * Converts a `#rrggbb` hex string into a packed `u32` `(r << 24) | (g << 16) | (b << 8) | 0xff`.
 */
export function hexToRgbaU32(hex: string): number {
  const clean = hex.replace(/^#/, '');
  const r = parseInt(clean.slice(0, 2), 16) & 0xff;
  const g = parseInt(clean.slice(2, 4), 16) & 0xff;
  const b = parseInt(clean.slice(4, 6), 16) & 0xff;
  return (((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0);
}

function unwrapAttr(val: AttributeValue | undefined): string | number | boolean | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return val;
  if (Array.isArray(val)) return val.length > 0 ? unwrapAttr(val[0]) : null;
  if ('enum' in val) return val.enum;
  if ('value' in val) return unwrapAttr(val.value);
  return null;
}

function extractPrimaryMaterial(materials: readonly MaterialInfo[] | undefined): string {
  if (!materials || materials.length === 0) return t('colorBy.noMaterial');
  for (const mat of materials) {
    if (mat.name?.trim()) return mat.name.trim();
    for (const layer of mat.layers ?? []) {
      if (layer.name?.trim()) return layer.name.trim();
    }
    for (const prof of mat.profiles ?? []) {
      if (prof.material?.trim()) return prof.material.trim();
      if (prof.name?.trim()) return prof.name.trim();
    }
    for (const c of mat.constituents ?? []) {
      if (c.material?.trim()) return c.material.trim();
      if (c.name?.trim()) return c.name.trim();
    }
  }
  return t('colorBy.noMaterial');
}

function extractNamedProperty(element: ColorableElement, propertyName: string): string {
  const target = propertyName.trim().toLowerCase();
  if (!target) return t('colorBy.noValue');
  const details = element.details;

  const allSets: PropertySetItem[] = [
    ...(details?.propertySets ?? []),
    ...(((details as unknown as { typePropertySets?: PropertySetItem[] })?.typePropertySets) ?? [])
  ];
  for (const pset of allSets) {
    for (const prop of pset.properties) {
      if (prop.name.trim().toLowerCase() === target) {
        if (prop.value !== null && prop.value !== undefined && String(prop.value).trim() !== '') {
          return String(prop.value);
        }
      }
    }
  }

  if (details?.attributes) {
    for (const [k, v] of Object.entries(details.attributes)) {
      if (k.trim().toLowerCase() === target) {
        const scalar = unwrapAttr(v);
        if (scalar !== null && String(scalar).trim() !== '') {
          return String(scalar);
        }
      }
    }
  }

  if (target === 'name') {
    const n = details?.name || element.name;
    return n?.trim() ? n.trim() : t('colorBy.noValue');
  }
  if (target === 'globalid') {
    return details?.globalId?.trim() || t('colorBy.noValue');
  }

  return t('colorBy.noValue');
}

/**
 * Extracts the category string for one element under the selected `ColorByMode`.
 */
export function extractElementCategory(
  element: ColorableElement,
  mode: ColorByMode,
  propertyName?: string
): string {
  switch (mode) {
    case 'none':
      return '';
    case 'class':
      return (element.details?.type || element.ifcClass || '').trim() || t('colorBy.noClass');
    case 'storey':
      return (element.storey || '').trim() || t('colorBy.noStorey');
    case 'material':
      return extractPrimaryMaterial(element.details?.materials);
    case 'property':
      return extractNamedProperty(element, propertyName ?? '');
  }
}

/**
 * Builds the legend and per-model `expressId -> rgba` map for the active `ColorByMode`.
 */
export function buildColorScheme(
  elements: readonly ColorableElement[],
  mode: ColorByMode,
  propertyName?: string
): ColorSchemeResult {
  if (mode === 'none' || (mode === 'property' && !(propertyName ?? '').trim())) {
    return { legend: [], colorsByModel: new Map() };
  }

  const counts = new Map<string, number>();
  const elementCategories: Array<{ modelId: ModelId; expressId: number; label: string }> = [];

  for (const el of elements) {
    const label = extractElementCategory(el, mode, propertyName);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    elementCategories.push({ modelId: el.modelId, expressId: el.expressId, label });
  }

  const fallbackLabels = getFallbackLabels();
  const intlLocale = getIntlLocale();
  const sortedLabels = Array.from(counts.keys()).sort((a, b) => {
    const aFallback = fallbackLabels.has(a);
    const bFallback = fallbackLabels.has(b);
    if (aFallback !== bFallback) return aFallback ? 1 : -1;
    return a.localeCompare(b, intlLocale);
  });

  const labelToColor = new Map<string, { hex: string; rgba: number }>();
  let paletteIdx = 0;
  for (const label of sortedLabels) {
    const hex = fallbackLabels.has(label)
      ? FALLBACK_HEX
      : CATEGORY_PALETTE[paletteIdx++ % CATEGORY_PALETTE.length];
    labelToColor.set(label, { hex, rgba: hexToRgbaU32(hex) });
  }

  const legend: ColorLegendItem[] = sortedLabels.map((label) => {
    const color = labelToColor.get(label)!;
    return {
      label,
      hex: color.hex,
      rgba: color.rgba,
      count: counts.get(label) ?? 0
    };
  });

  const colorsByModel = new Map<ModelId, Map<number, number>>();
  for (const item of elementCategories) {
    let modelMap = colorsByModel.get(item.modelId);
    if (!modelMap) {
      modelMap = new Map<number, number>();
      colorsByModel.set(item.modelId, modelMap);
    }
    const color = labelToColor.get(item.label)!;
    modelMap.set(item.expressId, color.rgba);
  }

  return { legend, colorsByModel };
}

/**
 * Collects all distinct property, quantity, and attribute names across the given elements.
 */
export function collectAvailablePropertyNames(elements: readonly ColorableElement[]): string[] {
  const names = new Set<string>();
  for (const el of elements) {
    const details = el.details;
    if (!details) continue;
    for (const pset of details.propertySets ?? []) {
      for (const prop of pset.properties) {
        if (prop.name?.trim()) names.add(prop.name.trim());
      }
    }
    for (const k of Object.keys(details.attributes ?? {})) {
      if (k.trim()) names.add(k.trim());
    }
  }
  const intlLocale = getIntlLocale();
  return Array.from(names).sort((a, b) => a.localeCompare(b, intlLocale));
}
