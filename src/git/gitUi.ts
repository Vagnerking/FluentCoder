export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function joinRepoPath(rootPath: string, relativePath: string): string {
  const clean = relativePath.replace(/^[/\\]+/, "");
  return `${rootPath.replace(/[\\/]+$/, "")}/${clean}`;
}

export function commitFileStatusClass(status: string): string {
  switch (status.charAt(0)) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    default:
      return "modified";
  }
}
