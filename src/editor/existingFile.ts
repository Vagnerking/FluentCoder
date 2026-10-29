import { samePath } from "../paths.ts";

export type ResolveSameFile = (path: string, candidates: string[]) => Promise<number | null>;

/** Keep the stored spelling and buffer when another path identifies an open file. */
export async function findExistingFile<T extends { path: string }>(
  files: readonly T[],
  path: string,
  resolve?: ResolveSameFile,
): Promise<T | undefined> {
  const direct = files.find((file) => file.path === path);
  if (direct || !files.length) return direct;
  if (!resolve) return files.find((file) => samePath(file.path, path));
  try {
    const index = await resolve(path, files.map((file) => file.path));
    return index !== null && Number.isInteger(index) && index >= 0 ? files[index] : undefined;
  } catch {
    // Missing/unreadable paths follow the normal open error path. Never guess
    // identity by folding every POSIX path or by consulting the host for SSH.
    return undefined;
  }
}
