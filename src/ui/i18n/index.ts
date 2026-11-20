import { es } from './es';
import {
  applyActiveLocale,
  DEFAULT_LOCALE,
  formatBytes,
  formatDate,
  formatFixed,
  formatLength,
  formatNumber,
  getIntlLocale,
  getLocale,
  subscribeLocale,
  type LocaleId
} from './format';

export interface PluralEntry {
  readonly one: string;
  readonly other: string;
}

type LeafValue = string | PluralEntry;

type CatalogueShape<T> = {
  readonly [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends PluralEntry
      ? PluralEntry
      : CatalogueShape<T[K]>;
};

/** Type every future language catalogue must satisfy so missing keys fail `tsc --noEmit`. */
export type I18nCatalogue = CatalogueShape<typeof es>;

type DotKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends LeafValue
    ? `${Prefix}${K}`
    : T[K] extends Record<string, unknown>
      ? DotKeys<T[K], `${Prefix}${K}.`>
      : never;
}[keyof T & string];

type Lookup<T, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? Lookup<T[Head], Rest>
    : never
  : Path extends keyof T
    ? T[Path]
    : never;

export type I18nKey = DotKeys<typeof es>;

type ParamsFor<K extends I18nKey> =
  Lookup<typeof es, K> extends PluralEntry
    ? [{ count: number } & Record<string, string | number>]
    : [params?: Record<string, string | number>];

const CATALOGUES: Record<LocaleId, I18nCatalogue> = {
  es
};

const pluralRulesCache = new Map<string, Intl.PluralRules>();

function getPluralRules(intlLocale: string): Intl.PluralRules {
  let rules = pluralRulesCache.get(intlLocale);
  if (!rules) {
    rules = new Intl.PluralRules(intlLocale);
    pluralRulesCache.set(intlLocale, rules);
  }
  return rules;
}

function lookupEntry(catalogue: I18nCatalogue, key: string): LeafValue {
  let current: unknown = catalogue;
  for (const segment of key.split('.')) {
    if (current && typeof current === 'object' && segment in current) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new Error(`Missing i18n key: ${key}`);
    }
  }
  if (typeof current === 'string') return current;
  if (current && typeof current === 'object' && 'one' in current && 'other' in current) {
    return current as PluralEntry;
  }
  throw new Error(`Invalid i18n leaf for key: ${key}`);
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => {
    const val = params[name];
    return val !== undefined ? String(val) : whole;
  });
}

/**
 * Translates a typed catalogue key with optional parameter interpolation and locale-aware
 * plural selection (`Intl.PluralRules`).
 */
export function t<K extends I18nKey>(key: K, ...args: ParamsFor<K>): string {
  const params = args[0] as Record<string, string | number> | undefined;
  const catalogue = CATALOGUES[getLocale()] ?? CATALOGUES[DEFAULT_LOCALE];
  const entry = lookupEntry(catalogue, key);
  if (typeof entry === 'string') {
    return interpolate(entry, params);
  }
  const count = typeof params?.count === 'number' ? params.count : Number(params?.count ?? 0);
  const rule = getPluralRules(getIntlLocale()).select(count);
  const template = rule === 'one' ? entry.one : entry.other;
  return interpolate(template, params);
}

/**
 * Changes the active UI locale, synchronizes `<html lang="...">` and `document.title`,
 * and notifies subscribers.
 */
export function setLocale(locale: LocaleId): void {
  const catalogue = CATALOGUES[locale] ?? CATALOGUES[DEFAULT_LOCALE];
  const title = lookupEntry(catalogue, 'app.documentTitle');
  applyActiveLocale(locale, typeof title === 'string' ? title : undefined);
}

// Ensure `<html lang="...">` matches the active locale on load in the browser.
if (typeof document !== 'undefined') {
  document.documentElement.lang = getLocale();
}

export {
  DEFAULT_LOCALE,
  es,
  formatBytes,
  formatDate,
  formatFixed,
  formatLength,
  formatNumber,
  getIntlLocale,
  getLocale,
  subscribeLocale,
  type LocaleId
};
