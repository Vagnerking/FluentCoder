/** Provider names are presentation only; identify the host rather than URL text. */
export function remoteProviderLabel(value: string): string {
  const raw = value.trim();
  let hostname: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      hostname = new URL(raw).hostname.toLowerCase();
    } catch {
      return "Git";
    }
  } else {
    const scp = /^(?:[^@/\s:]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(raw);
    if (!scp) return "Git";
    hostname = scp[1].toLowerCase();
  }
  for (const [domain, label] of [["github.com", "GitHub"], ["gitlab.com", "GitLab"], ["bitbucket.org", "Bitbucket"]]) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return label;
  }
  return "Git";
}
