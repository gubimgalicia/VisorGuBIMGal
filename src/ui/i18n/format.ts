export type LocaleId = 'es';

export const DEFAULT_LOCALE: LocaleId = 'es';

const INTL_LOCALES: Record<LocaleId, string> = {
  es: 'es-ES'
};

let activeLocale: LocaleId = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

export function getLocale(): LocaleId {
  return activeLocale;
}

export function getIntlLocale(locale: LocaleId = activeLocale): string {
  return INTL_LOCALES[locale] ?? locale;
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyLocaleChange(): void {
  for (const listener of listeners) listener();
}

export function applyActiveLocale(locale: LocaleId, documentTitle?: string): void {
  activeLocale = locale;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    if (documentTitle) {
      document.title = documentTitle;
    }
  }
  notifyLocaleChange();
}

/**
 * Formats a number using `Intl.NumberFormat` for the active locale (defaults to `es-ES`).
 */
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  locale: LocaleId = activeLocale
): string {
  return new Intl.NumberFormat(getIntlLocale(locale), options).format(value);
}

/**
 * Formats a date using `Intl.DateTimeFormat` for the active locale (defaults to `es-ES`).
 */
export function formatDate(
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
  locale: LocaleId = activeLocale
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(getIntlLocale(locale), options).format(date);
}

/**
 * Formats a fixed-decimal number via `Intl.NumberFormat` without thousands grouping.
 *
 * When `decimalStyle` is `'dot'` (default for CAD/engineering values so existing Spanish UI
 * outputs like `1.20 m` and `38.9 KB` remain unchanged), the decimal token from `formatToParts`
 * uses `'.'`; `'locale'` keeps the locale's standard decimal separator (`,` in `es-ES`).
 */
export function formatFixed(
  value: number,
  decimals: number,
  options?: {
    minimumFractionDigits?: number;
    decimalStyle?: 'dot' | 'locale';
    locale?: LocaleId;
  }
): string {
  const locale = options?.locale ?? activeLocale;
  const decimalStyle = options?.decimalStyle ?? 'dot';
  const minFrac = options?.minimumFractionDigits ?? decimals;
  const nf = new Intl.NumberFormat(getIntlLocale(locale), {
    minimumFractionDigits: minFrac,
    maximumFractionDigits: decimals,
    useGrouping: false
  });
  if (decimalStyle === 'locale') return nf.format(value);
  return nf
    .formatToParts(value)
    .map((part) => (part.type === 'decimal' ? '.' : part.value))
    .join('');
}

/**
 * Formats a length in metres using `Intl.NumberFormat` (defaulting to `es-ES`).
 */
export function formatLength(
  meters: number,
  decimals = 2,
  options?: {
    unit?: boolean;
    signed?: boolean;
    decimalStyle?: 'dot' | 'locale';
    locale?: LocaleId;
  }
): string {
  const locale = options?.locale ?? activeLocale;
  const decimalStyle = options?.decimalStyle ?? 'dot';
  const includeUnit = options?.unit ?? true;
  const signPrefix = options?.signed ? (meters >= 0 ? '+' : '-') : '';
  const magnitude = options?.signed ? Math.abs(meters) : meters;
  const nf = new Intl.NumberFormat(getIntlLocale(locale), {
    ...(includeUnit ? { style: 'unit' as const, unit: 'meter', unitDisplay: 'short' as const } : {}),
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false
  });
  const formatted =
    decimalStyle === 'locale'
      ? nf.format(magnitude)
      : nf
          .formatToParts(magnitude)
          .map((part) => (part.type === 'decimal' ? '.' : part.value))
          .join('');
  return `${signPrefix}${formatted}`;
}

/**
 * Formats a byte size into `B`, `KB`, `MB`, or `GB` using `Intl.NumberFormat`.
 */
export function formatBytes(
  bytes: number,
  options?: { minimumFractionDigits?: number; decimalStyle?: 'dot' | 'locale'; locale?: LocaleId }
): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  const num = formatFixed(value, 1, {
    minimumFractionDigits: options?.minimumFractionDigits ?? 0,
    decimalStyle: options?.decimalStyle ?? 'dot',
    locale: options?.locale
  });
  return `${num} ${units[unitIdx]}`;
}
