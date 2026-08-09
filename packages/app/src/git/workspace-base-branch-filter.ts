/**
 * Substring match, prefix hits first. Branch names are long and share prefixes
 * (`mmilenkovic/feat-…`), so the useful query is usually a fragment from the middle.
 */
export function filterBranches(branches: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...branches];
  const matches: { branch: string; index: number }[] = [];
  for (const branch of branches) {
    const index = branch.toLowerCase().indexOf(needle);
    if (index >= 0) matches.push({ branch, index });
  }
  matches.sort((a, b) => a.index - b.index);
  return matches.map((match) => match.branch);
}
