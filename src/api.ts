import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { FileNode, RawDirEntry } from "./types";

/** Opens the native folder picker; returns the chosen path or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

/** Lists the immediate children of `path` and maps them to `FileNode`s. */
export async function readDir(path: string): Promise<FileNode[]> {
  const entries = await invoke<RawDirEntry[]>("read_dir", { path });
  return entries.map((e) => ({
    name: e.name,
    path: e.path,
    isDir: e.is_dir,
  }));
}

/** Reads a text file's contents. */
export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

/** Writes contents to a file. */
export function writeFile(path: string, contents: string): Promise<void> {
  return invoke("write_file", { path, contents });
}

export function termCreate(id: string, cwd: string, cols: number, rows: number): Promise<void> {
  return invoke("term_create", { id, cwd, cols, rows });
}
export function termWrite(id: string, data: string): Promise<void> {
  return invoke("term_write", { id, data });
}
export function termResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("term_resize", { id, cols, rows });
}
export function termClose(id: string): Promise<void> {
  return invoke("term_close", { id });
}
