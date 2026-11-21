/**
 * Pure connectivity state logic for the GIS panel (E5).
 *
 * Tracks both `navigator.onLine` and real tile load/error feedback from Leaflet
 * (OSM / IGN PNOA), so offline desktop or blocked-network sessions show a clear state.
 */
export type GisConnectionStatus = 'online' | 'offline';

export interface GisOnlineState {
  status: GisConnectionStatus;
  consecutiveTileErrors: number;
  anyTileLoaded: boolean;
}

export const GIS_OFFLINE_ERROR_THRESHOLD = 2;

export function initialGisOnlineState(navigatorOnline: boolean): GisOnlineState {
  return {
    status: navigatorOnline ? 'online' : 'offline',
    consecutiveTileErrors: 0,
    anyTileLoaded: false
  };
}

export function reduceGisOnlineState(
  state: GisOnlineState,
  event: 'browser-online' | 'browser-offline' | 'tile-load' | 'tile-error' | 'retry'
): GisOnlineState {
  switch (event) {
    case 'browser-offline':
      return { ...state, status: 'offline' };
    case 'browser-online':
    case 'retry':
      return { ...state, status: 'online', consecutiveTileErrors: 0 };
    case 'tile-load':
      return { status: 'online', consecutiveTileErrors: 0, anyTileLoaded: true };
    case 'tile-error': {
      const nextErrors = state.consecutiveTileErrors + 1;
      const shouldMarkOffline =
        state.status === 'offline' || nextErrors >= GIS_OFFLINE_ERROR_THRESHOLD;
      return {
        ...state,
        consecutiveTileErrors: nextErrors,
        status: shouldMarkOffline ? 'offline' : state.status
      };
    }
  }
}
