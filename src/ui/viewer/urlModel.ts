export interface ModelUrlTarget {
  url: string;
  fileName: string;
}

export function parseModelUrlParam(search: string, baseHref?: string): ModelUrlTarget | null {
  const params = new URLSearchParams(search);
  const raw = (params.get('model') ?? params.get('ifc') ?? '').trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = baseHref ? new URL(raw, baseHref) : new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : '';
  let decoded = '';
  try {
    decoded = decodeURIComponent(lastSegment).trim();
  } catch {
    decoded = lastSegment.trim();
  }

  let fileName = decoded || 'modelo.ifc';
  if (!fileName.toLowerCase().endsWith('.ifc')) {
    fileName = `${fileName}.ifc`;
  }

  return {
    url: parsed.href,
    fileName
  };
}
