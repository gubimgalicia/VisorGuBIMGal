import type { FilePort, OpenedFileSource, SaveFileOptions } from '../../domain/files/FilePort';

/** Browser implementation of `FilePort`: uses `<a download>` and lets `<input type="file">` handle picking. */
export class WebFilePort implements FilePort {
  readonly usesNativePicker = false;

  async pickIfcFile(): Promise<OpenedFileSource | null> {
    return null;
  }

  async saveFile(options: SaveFileOptions): Promise<boolean> {
    if (typeof document === 'undefined' || typeof URL === 'undefined') {
      return false;
    }
    const part: BlobPart =
      typeof options.content === 'string'
        ? options.content
        : new Uint8Array(options.content);
    const blob = new Blob([part], { type: options.mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = options.defaultName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return true;
  }

  async openPath(_filePath: string): Promise<OpenedFileSource | null> {
    return null;
  }

  onExternalOpen(_listener: (source: OpenedFileSource) => void): () => void {
    return () => {};
  }

  async consumeInitialFiles(): Promise<OpenedFileSource[]> {
    return [];
  }
}
