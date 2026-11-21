import type { FilePort } from '../domain/files/FilePort';
import type { KernelPort } from '../domain/kernel/KernelPort';
import { isTauriHost, TauriFilePort } from './files/TauriFilePort';
import { WebFilePort } from './files/WebFilePort';
import { WasmKernelAdapter } from './kernel/WasmKernelAdapter';
import { AutoRenderer } from './renderer/AutoRenderer';

export const kernel: KernelPort = new WasmKernelAdapter();
export const renderer = new AutoRenderer();
export const filePort: FilePort = isTauriHost() ? new TauriFilePort() : new WebFilePort();
