import L from 'leaflet';
import { DEFAULT_GALICIA_CENTER } from '../../domain/coordinates/Coordinates';

export interface MapMarkerData {
  id: string;
  title: string;
  lat: number;
  lng: number;
}

export class LeafletService {
  private map: L.Map | null = null;
  private markersLayer: L.LayerGroup | null = null;

  initialize(container: HTMLElement, onMapClick?: (lat: number, lng: number) => void): L.Map {
    if (this.map) {
      this.map.remove();
    }

    const map = L.map(container, {
      center: DEFAULT_GALICIA_CENTER,
      zoom: 12,
      zoomControl: true
    });

    // Sleek Dark Tile layer
    const darkTiles = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a>, &copy; <a href="https://osm.org/">OSM</a>',
        maxZoom: 19
      }
    );

    // OpenStreetMap standard
    const osmTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    });

    // PNOA Ortofoto (IGN España WMS)
    const pnoaWms = L.tileLayer.wms('https://www.ign.es/wms-inspire/pnoa-ma', {
      layers: 'OI.OrthoimageCoverage',
      format: 'image/png',
      transparent: true,
      attribution: '&copy; Instituto Geográfico Nacional de España'
    });

    darkTiles.addTo(map);

    L.control
      .layers(
        {
          'Carto Voyager': darkTiles,
          OpenStreetMap: osmTiles,
          'Ortofoto PNOA (IGN)': pnoaWms
        },
        undefined,
        { position: 'topright' }
      )
      .addTo(map);

    this.markersLayer = L.layerGroup().addTo(map);

    if (onMapClick) {
      map.on('click', (e) => {
        onMapClick(e.latlng.lat, e.latlng.lng);
      });
    }

    this.map = map;
    return map;
  }

  updateModelMarkers(markers: MapMarkerData[]): void {
    if (!this.markersLayer || !this.map) return;
    this.markersLayer.clearLayers();

    const bounds = L.latLngBounds([]);

    for (const marker of markers) {
      const latLng = L.latLng(marker.lat, marker.lng);
      bounds.extend(latLng);

      const customIcon = L.divIcon({
        className: 'custom-map-pin',
        html: `<div style="background:#2563eb; color:white; border-radius:50%; width:28px; height:28px; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 6px rgba(0,0,0,0.4); font-size:12px; font-weight:bold; border:2px solid white;">BIM</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });

      const m = L.marker(latLng, { icon: customIcon });
      m.bindPopup(`<strong>${marker.title}</strong><br/>Coordenadas: ${marker.lat.toFixed(5)}, ${marker.lng.toFixed(5)}`);
      m.addTo(this.markersLayer);
    }

    if (markers.length > 0) {
      this.map.fitBounds(bounds, { maxZoom: 15, padding: [40, 40] });
    }
  }

  setCenter(lat: number, lng: number, zoom = 14): void {
    this.map?.setView([lat, lng], zoom);
  }

  invalidateSize(): void {
    this.map?.invalidateSize();
  }

  destroy(): void {
    this.map?.remove();
    this.map = null;
    this.markersLayer = null;
  }
}

export const leafletService = new LeafletService();
