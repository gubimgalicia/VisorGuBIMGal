/** A file-like handle readable on demand without retaining bytes in memory. */
export interface OpenedFileSource {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Parameters for saving a generated artifact (DXF, SVG, PDF, CSV, GLB, BCF). */
export interface SaveFileOptions {
  defaultName: string;
  content: string | Uint8Array;
  mimeType: string;
  /** Human-readable filter label for native save dialogs, e.g. 'Plano DXF'. */
  filterName?: string;
  /** Allowed file extensions without leading dot, e.g. ['dxf']. */
  extensions?: readonly string[];
}

/**
 * Host abstraction for opening and saving local files (E2).
 *
 * Chosen once in `src/infrastructure/composition.ts` so the rest of the application
 * never branches on web vs. desktop.
 */
export interface FilePort {
  /** True when the host opens files via a native OS dialog instead of a DOM `<input type="file">`. */
  readonly usesNativePicker: boolean;
  /** Opens a native IFC file picker; returns null if cancelled or if the host uses DOM `<input>`. */
  pickIfcFile(): Promise<OpenedFileSource | null>;
  /** Saves text or binary output via browser download or native save dialog. Returns true if saved. */
  saveFile(options: SaveFileOptions): Promise<boolean>;
  /** Opens an IFC directly from a local file path (desktop only; returns null on web). */
  openPath(filePath: string): Promise<OpenedFileSource | null>;
  /** Subscribes to OS file-open requests (double-click `.ifc`, second instance). Returns unsubscribe fn. */
  onExternalOpen(listener: (source: OpenedFileSource) => void): () => void;
  /** Drains any files passed when the application launched (e.g. `.ifc` double-click). */
  consumeInitialFiles(): Promise<OpenedFileSource[]>;
}
