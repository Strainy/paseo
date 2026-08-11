import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import pLimit from "p-limit";
import {
  createRealpathAwarePathMatcher,
  getRealpathAwareRelativePath,
  normalizePathForIdentity,
} from "../utils/path.js";
import type { ProjectRegistry } from "./workspace-registry.js";
import type { WorkspaceGitReadOptions, WorkspaceGitService } from "./workspace-git-service.js";

const PROJECT_IMPORT_SCOPE_GIT_CONCURRENCY = 4;

export type ProjectImportScopeErrorCode =
  | "unknown_project"
  | "archived_project"
  | "unavailable_project_root";

export class ProjectImportScopeError extends Error {
  constructor(
    readonly code: ProjectImportScopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectImportScopeError";
  }
}

export interface ProjectImportScope {
  projectId: string;
  exactCwds: readonly string[];
  matchesCwd(candidate: string): Promise<boolean>;
}

export interface ResolveProjectImportScopeOptions {
  force?: boolean;
  reason?: string;
}

export interface ProjectImportScopeResolver {
  resolve(
    projectId: string,
    options?: ResolveProjectImportScopeOptions,
  ): Promise<ProjectImportScope>;
}

export function createProjectImportScopeResolver(deps: {
  projectRegistry: Pick<ProjectRegistry, "get">;
  workspaceGitService: Pick<WorkspaceGitService, "getGitCheckoutIdentity" | "listLinkedWorktrees">;
}): ProjectImportScopeResolver {
  return {
    async resolve(projectId, options = {}) {
      const project = await deps.projectRegistry.get(projectId);
      if (!project) {
        throw new ProjectImportScopeError("unknown_project", `Unknown project: ${projectId}`);
      }
      if (project.archivedAt) {
        throw new ProjectImportScopeError("archived_project", `Archived project: ${projectId}`);
      }

      const projectRoot = resolve(project.rootPath);
      const projectRootStats = await stat(projectRoot).catch(() => null);
      if (!projectRootStats?.isDirectory()) {
        throw unavailableProjectRoot(projectId, projectRoot);
      }

      const readOptions = toGitReadOptions(options);
      const selectedIdentity = await deps.workspaceGitService.getGitCheckoutIdentity(
        projectRoot,
        readOptions,
      );
      if (!selectedIdentity) {
        if (project.kind === "git") {
          throw unavailableProjectRoot(projectId, projectRoot);
        }
        return buildScope(projectId, [projectRoot]);
      }

      const relativeProjectRoot = getRealpathAwareRelativePath(
        selectedIdentity.worktreeRoot,
        projectRoot,
      );
      if (relativeProjectRoot === null) {
        throw unavailableProjectRoot(projectId, projectRoot);
      }

      const linkedWorktrees = await deps.workspaceGitService.listLinkedWorktrees(
        projectRoot,
        readOptions,
      );
      const selectedIsLinked = linkedWorktrees.some(
        (worktree) =>
          createRealpathAwarePathMatcher(selectedIdentity.worktreeRoot)(worktree.worktreeRoot) &&
          createRealpathAwarePathMatcher(selectedIdentity.commonDir)(worktree.commonDir),
      );
      if (!selectedIsLinked) {
        throw unavailableProjectRoot(projectId, projectRoot);
      }

      const limit = pLimit({ concurrency: PROJECT_IMPORT_SCOPE_GIT_CONCURRENCY });
      const mappedCwds = await Promise.all(
        linkedWorktrees.map((worktree) =>
          limit(async () => {
            const mappedCwd = resolve(worktree.worktreeRoot, relativeProjectRoot);
            const mappedStats = await stat(mappedCwd).catch(() => null);
            if (!mappedStats?.isDirectory()) return null;

            // The mapped directory can itself be a nested repository or a symlink to an
            // independent clone. Re-read its lightweight Git identity before trusting it.
            const mappedIdentity = await deps.workspaceGitService.getGitCheckoutIdentity(
              mappedCwd,
              readOptions,
            );
            if (!mappedIdentity) return null;
            if (
              !createRealpathAwarePathMatcher(worktree.worktreeRoot)(mappedIdentity.worktreeRoot)
            ) {
              return null;
            }
            if (
              !createRealpathAwarePathMatcher(selectedIdentity.commonDir)(mappedIdentity.commonDir)
            ) {
              return null;
            }
            return mappedCwd;
          }),
        ),
      );

      const exactCwds = mappedCwds.filter((cwd): cwd is string => cwd !== null);
      if (!exactCwds.some(createRealpathAwarePathMatcher(projectRoot))) {
        throw unavailableProjectRoot(projectId, projectRoot);
      }
      return buildScope(projectId, exactCwds);
    },
  };
}

function buildScope(projectId: string, cwds: readonly string[]): ProjectImportScope {
  const exactCwds = Array.from(
    new Map(cwds.map((cwd) => [normalizePathForIdentity(cwd), resolve(cwd)])).values(),
  ).sort((left, right) => left.localeCompare(right));
  const matchers = exactCwds.map((cwd) => createRealpathAwarePathMatcher(cwd));
  return {
    projectId,
    exactCwds,
    matchesCwd: async (candidate) => matchers.some((matches) => matches(candidate)),
  };
}

function toGitReadOptions(options: ResolveProjectImportScopeOptions): WorkspaceGitReadOptions {
  if (options.force) {
    return {
      force: true,
      reason: options.reason ?? "project-import-scope",
    };
  }
  return { reason: options.reason ?? "project-import-scope" };
}

function unavailableProjectRoot(projectId: string, projectRoot: string): ProjectImportScopeError {
  return new ProjectImportScopeError(
    "unavailable_project_root",
    `Project root is unavailable for import: ${projectId} (${projectRoot})`,
  );
}
