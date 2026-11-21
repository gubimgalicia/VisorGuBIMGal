import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { FilePort, OpenedFileSource, SaveFileOptions } from '../../domain/files/FilePort';

/** Metadata returned by Rust after registering an authorized file for the `gubim-file` protocol. */
export interface DesktopFileToken {
  token: string;
  name: string;
  size: number;
}

/** True only when running inside a Tauri v2 WebView host. */
export function isTauriHost(win: unknown = typeof window !== 'undefined' ? window : undefined): boolean {
  if (!win || typeof win !== 'object') return false;
  return '__TAURI_INTERNALS__' in (win as Record<string, unknown>);
}

/**
 * Builds the local-file protocol URL used to stream large `.ifc` files directly as raw binary
 * without passing bytes through Tauri's JSON IPC channel (E4).
 */
export function desktopFileProtocolUrl(token: string): string {
  return `http://gubim-file.localhost/${encodeURIComponent(token)}`;
}

function toOpenedFileSource(meta: DesktopFileToken): OpenedFileSource {
  const url = desktopFileProtocolUrl(meta.token);
  return {
    name: meta.name,
    size: meta.size,
    async arrayBuffer(): Promise<ArrayBuffer> {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`No se pudo leer el archivo local (${response.status}).`);
      }
      return response.arrayBuffer();
    }
  };
}

function encodeContentBytes(content: string | Uint8Array): Uint8Array {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content);
  }
  return content;
}

/**
 * Desktop implementation of `FilePort` backed by Tauri v2 native dialogs, single-instance
 * file-open events, and the `gubim-file` local-file streaming protocol (E1, E2, E4).
 */
export class TauriFilePort implements FilePort {
  readonly usesNativePicker = true;

  async pickIfcFile(): Promise<OpenedFileSource | null> {
    const meta = await invoke<DesktopFileToken | null>('pick_ifc_file');
    return meta ? toOpenedFileSource(meta) : null;
  }

  async saveFile(options: SaveFileOptions): Promise<boolean> {
    const bytes = encodeContentBytes(options.content);
    // Transfer raw bytes using Tauri v2 binary command payload (no base64/JSON array inflation).
    const saved = await invoke<boolean>(
      'save_exported_file',
      bytes,
      {
        headers: {
          'x-gubim-filename': encodeURIComponent(options.defaultName),
          'x-gubim-filter-name': encodeURIComponent(options.filterName ?? ''),
          'x-gubim-extensions': encodeURIComponent((options.extensions ?? []).join(','))
        }
      }
    );
    return Boolean(saved);
  }

  async openPath(filePath: string): Promise<OpenedFileSource | null> {
    const meta = await invoke<DesktopFileToken | null>('register_ifc_path', { path: filePath });
    return meta ? toOpenedFileSource(meta) : null;
  }

  onExternalOpen(listener: (source: OpenedFileSource) => void): () => void {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<DesktopFileToken>('gubim://open-file', (event) => {
      if (!active || !event.payload) return;
      listener(toOpenedFileSource(event.payload));
    }).then((fn) => {
      if (!active) fn();
      else unlisten = fn;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }

  async consumeInitialFiles(): Promise<OpenedFileSource[]> {
    const list = await invoke<DesktopFileToken[]>('take_pending_files');
    return Array.isArray(list) ? list.map(toOpenedFileSource) : [];
  }
}
