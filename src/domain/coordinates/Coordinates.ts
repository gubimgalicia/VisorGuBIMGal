import proj4 from 'proj4';

// ETRS89 / UTM zone 29N (Galicia & Western Spain)
proj4.defs(
  'EPSG:25829',
  '+proj=utm +zone=29 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs'
);

// ETRS89 / UTM zone 30N (Central Spain)
proj4.defs(
  'EPSG:25830',
  '+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs'
);

// Santiago de Compostela (Galicia default center)
export const DEFAULT_GALICIA_CENTER: [number, number] = [42.8782, -8.5448];

export interface GeoLocation {
  lat: number;
  lng: number;
}

export function utm29NToLatLng(eastings: number, northings: number): GeoLocation {
  try {
    const [lng, lat] = proj4('EPSG:25829', 'EPSG:4326', [eastings, northings]);
    return { lat, lng };
  } catch (err) {
    console.warn('Failed to project UTM 29N to LatLng:', err);
    return { lat: DEFAULT_GALICIA_CENTER[0], lng: DEFAULT_GALICIA_CENTER[1] };
  }
}

export function latLngToUtm29N(lat: number, lng: number): [number, number] {
  try {
    const [eastings, northings] = proj4('EPSG:4326', 'EPSG:25829', [lng, lat]);
    return [eastings, northings];
  } catch (err) {
    console.warn('Failed to project LatLng to UTM 29N:', err);
    return [537000, 4747000];
  }
}

export function detectCrsFromText(name?: string, desc?: string): string | undefined {
  const text = `${name || ''} ${desc || ''}`.toUpperCase();
  if (text.includes('25829') || (text.includes('UTM') && text.includes('29'))) {
    return 'EPSG:25829';
  }
  if (text.includes('25830') || (text.includes('UTM') && text.includes('30'))) {
    return 'EPSG:25830';
  }
  if (text.includes('4326') || text.includes('WGS84')) {
    return 'EPSG:4326';
  }
  if (text.includes('3857') || text.includes('PSEUDO-MERCATOR')) {
    return 'EPSG:3857';
  }
  return undefined;
}
