export function normalizeWorkspaceLabels(labels: Iterable<string>): string[] {
  return Array.from(
    new Set(Array.from(labels, (label) => label.trim()).filter((label) => label.length > 0)),
  );
}

export function parseWorkspaceLabelsInput(input: string): string[] {
  return normalizeWorkspaceLabels(input.split(","));
}

/** Moves the labels used in the latest save to the front while preserving their submitted order. */
export function recordRecentWorkspaceLabels(
  recentLabels: readonly string[],
  usedLabels: readonly string[],
): string[] {
  const used = normalizeWorkspaceLabels(usedLabels);
  const usedSet = new Set(used);
  return [
    ...used,
    ...normalizeWorkspaceLabels(recentLabels).filter((label) => !usedSet.has(label)),
  ];
}

/**
 * Saved recency is authoritative. Labels discovered from existing workspaces follow it in a
 * stable order because older daemons do not expose when a label was last changed.
 */
export function mergeWorkspaceLabelSuggestions(input: {
  recentLabels: readonly string[];
  selectedLabels: readonly string[];
  knownLabels: readonly string[];
}): string[] {
  const recent = normalizeWorkspaceLabels(input.recentLabels);
  const recentSet = new Set(recent);
  const fallback = normalizeWorkspaceLabels([...input.selectedLabels, ...input.knownLabels]).filter(
    (label) => !recentSet.has(label),
  );
  fallback.sort((left, right) => left.localeCompare(right));
  return [...recent, ...fallback];
}

export function filterWorkspaceLabelSuggestions(
  labels: readonly string[],
  query: string,
): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...labels];
  return labels.filter((label) => label.toLowerCase().includes(normalizedQuery));
}

export function resolveWorkspaceLabelDraftLabels(
  input: string,
  knownLabels: readonly string[],
): string[] {
  const knownByNormalizedName = new Map(
    knownLabels.map((label) => [label.trim().toLowerCase(), label] as const),
  );
  return parseWorkspaceLabelsInput(input).map(
    (label) => knownByNormalizedName.get(label.toLowerCase()) ?? label,
  );
}
