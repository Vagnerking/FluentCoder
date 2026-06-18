/** A node in the file explorer tree. Mirrors the Rust `DirEntry`. */
export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  /** Lazily loaded children; undefined until the folder is first expanded. */
  children?: FileNode[];
  /** Whether the folder is currently expanded in the UI. */
  expanded?: boolean;
}

/** Shape returned by the Rust `read_dir` command. */
export interface RawDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** A file currently open in the editor. */
export interface OpenFile {
  path: string;
  name: string;
  content: string;
  /** True when the buffer differs from what's on disk. */
  dirty: boolean;
}
