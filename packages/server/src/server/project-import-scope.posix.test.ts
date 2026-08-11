import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import { normalizePathForIdentity } from "../utils/path.js";
import {
  createProjectImportScopeResolver,
  ProjectImportScopeError,
} from "./project-import-scope.js";
import type { PersistedProjectRecord } from "./workspace-registry.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("project import scope", () => {
  let tempRoot: string;
  let gitService: WorkspaceGitServiceImpl;
  let projects: Map<string, PersistedProjectRecord>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "project-import-scope-"));
    gitService = new WorkspaceGitServiceImpl({
      logger: createTestLogger(),
      paseoHome: join(tempRoot, "paseo-home"),
    });
    projects = new Map();
  });

  afterEach(() => {
    gitService.dispose();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("maps an exact selected subdirectory across arbitrary linked worktree names", async () => {
    const repo = createRepository(join(tempRoot, "main", "lpu-monorepo"));
    const selectedRoot = join(repo, "packages", "compiler");
    const codexWorktree = join(tempRoot, ".codex", "worktrees", "a227", "unexpected-name");
    const paseoWorktree = join(tempRoot, ".paseo", "worktrees", "hash", "military-elephant");
    addWorktree(repo, codexWorktree, "codex-feature");
    addWorktree(repo, paseoWorktree, "paseo-feature");
    const independentClone = join(tempRoot, "independent", "lpu-monorepo");
    git(["clone", repo, independentClone], tempRoot);

    projects.set("lpu", project("lpu", selectedRoot, "git"));
    const resolver = createResolver(projects, gitService);
    const scope = await resolver.resolve("lpu");

    await expect(scope.matchesCwd(selectedRoot)).resolves.toBe(true);
    await expect(scope.matchesCwd(join(codexWorktree, "packages", "compiler"))).resolves.toBe(true);
    await expect(scope.matchesCwd(join(paseoWorktree, "packages", "compiler"))).resolves.toBe(true);
    await expect(scope.matchesCwd(repo)).resolves.toBe(false);
    await expect(scope.matchesCwd(join(selectedRoot, "src"))).resolves.toBe(false);
    await expect(scope.matchesCwd(join(independentClone, "packages", "compiler"))).resolves.toBe(
      false,
    );
    expect(scope.exactCwds).toHaveLength(3);
  });

  test("excludes missing, nested-repository, and symlinked-independent mapped directories", async () => {
    const repo = createRepository(join(tempRoot, "repo"));
    const selectedRoot = join(repo, "packages", "compiler");
    const missingWorktree = join(tempRoot, "linked", "missing");
    const nestedWorktree = join(tempRoot, "linked", "nested");
    const symlinkWorktree = join(tempRoot, "linked", "symlink");
    addWorktree(repo, missingWorktree, "missing-feature");
    addWorktree(repo, nestedWorktree, "nested-feature");
    addWorktree(repo, symlinkWorktree, "symlink-feature");

    rmSync(join(missingWorktree, "packages", "compiler"), { recursive: true, force: true });

    const nestedRoot = join(nestedWorktree, "packages", "compiler");
    rmSync(nestedRoot, { recursive: true, force: true });
    mkdirSync(nestedRoot, { recursive: true });
    git(["init", "-b", "main"], nestedRoot);

    const independent = createRepository(join(tempRoot, "independent"));
    const symlinkRoot = join(symlinkWorktree, "packages", "compiler");
    rmSync(symlinkRoot, { recursive: true, force: true });
    symlinkSync(independent, symlinkRoot, "dir");

    projects.set("lpu", project("lpu", selectedRoot, "git"));
    const scope = await createResolver(projects, gitService).resolve("lpu");

    expect(scope.exactCwds.map(normalizePathForIdentity)).toEqual([
      normalizePathForIdentity(selectedRoot),
    ]);
    await expect(scope.matchesCwd(join(missingWorktree, "packages", "compiler"))).resolves.toBe(
      false,
    );
    await expect(scope.matchesCwd(nestedRoot)).resolves.toBe(false);
    await expect(scope.matchesCwd(symlinkRoot)).resolves.toBe(false);
  });

  test("drops deleted prunable worktrees and refreshes the cached linked set on forced import", async () => {
    const repo = createRepository(join(tempRoot, "repo"));
    const selectedRoot = join(repo, "packages", "compiler");
    const deletedWorktree = join(tempRoot, "linked", "deleted");
    addWorktree(repo, deletedWorktree, "deleted-feature");
    rmSync(deletedWorktree, { recursive: true, force: true });

    projects.set("lpu", project("lpu", selectedRoot, "git"));
    const resolver = createResolver(projects, gitService);
    const initial = await resolver.resolve("lpu");
    expect(initial.exactCwds.map(normalizePathForIdentity)).toEqual([
      normalizePathForIdentity(selectedRoot),
    ]);

    const laterWorktree = join(tempRoot, "linked", "later");
    addWorktree(repo, laterWorktree, "later-feature");
    const cached = await resolver.resolve("lpu");
    await expect(cached.matchesCwd(join(laterWorktree, "packages", "compiler"))).resolves.toBe(
      false,
    );

    const fresh = await resolver.resolve("lpu", { force: true, reason: "provider-session-import" });
    await expect(fresh.matchesCwd(join(laterWorktree, "packages", "compiler"))).resolves.toBe(true);
  });

  test("excludes a bare repository entry from the linked worktree set", async () => {
    const seed = createRepository(join(tempRoot, "seed"));
    const bare = join(tempRoot, "repo.git");
    git(["clone", "--bare", seed, bare], tempRoot);
    const linked = join(tempRoot, "linked", "checkout");
    mkdirSync(join(linked, ".."), { recursive: true });
    git([`--git-dir=${bare}`, "worktree", "add", linked, "main"], tempRoot);

    const identities = await gitService.listLinkedWorktrees(linked);

    expect(identities.map((identity) => normalizePathForIdentity(identity.worktreeRoot))).toEqual([
      normalizePathForIdentity(linked),
    ]);
    expect(
      identities.some(
        (identity) =>
          normalizePathForIdentity(identity.worktreeRoot) === normalizePathForIdentity(bare),
      ),
    ).toBe(false);
  });

  test("uses one exact root for non-Git projects and fails closed for broken Git projects", async () => {
    const plainRoot = join(tempRoot, "plain");
    const aliasRoot = join(tempRoot, "plain-alias");
    mkdirSync(plainRoot, { recursive: true });
    symlinkSync(plainRoot, aliasRoot, "dir");
    projects.set("plain", project("plain", plainRoot, "non_git"));
    projects.set("broken", project("broken", plainRoot, "git"));
    const resolver = createResolver(projects, gitService);

    const scope = await resolver.resolve("plain");
    await expect(scope.matchesCwd(plainRoot)).resolves.toBe(true);
    await expect(scope.matchesCwd(aliasRoot)).resolves.toBe(true);
    await expect(scope.matchesCwd(join(plainRoot, "child"))).resolves.toBe(false);
    await expect(resolver.resolve("broken")).rejects.toMatchObject<ProjectImportScopeError>({
      code: "unavailable_project_root",
    });
  });

  test.each([
    ["missing", null, "unknown_project"],
    ["archived", "2026-08-10T00:00:00.000Z", "archived_project"],
  ] as const)("rejects %s projects", async (projectId, archivedAt, code) => {
    if (projectId === "archived") {
      const root = join(tempRoot, "archived");
      mkdirSync(root, { recursive: true });
      projects.set(projectId, { ...project(projectId, root, "non_git"), archivedAt });
    }

    await expect(createResolver(projects, gitService).resolve(projectId)).rejects.toMatchObject({
      code,
    });
  });
});

function createResolver(
  projects: Map<string, PersistedProjectRecord>,
  gitService: WorkspaceGitServiceImpl,
) {
  return createProjectImportScopeResolver({
    projectRegistry: { get: async (projectId) => projects.get(projectId) ?? null },
    workspaceGitService: gitService,
  });
}

function project(
  projectId: string,
  rootPath: string,
  kind: PersistedProjectRecord["kind"],
): PersistedProjectRecord {
  return {
    projectId,
    rootPath,
    kind,
    displayName: projectId,
    projectKey: null,
    customName: null,
    customIconRevision: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    archivedAt: null,
  };
}

function createRepository(repo: string): string {
  mkdirSync(repo, { recursive: true });
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Paseo Test"], repo);
  mkdirSync(join(repo, "packages", "compiler", "src"), { recursive: true });
  writeFileSync(join(repo, "packages", "compiler", "README.md"), "compiler\n");
  git(["add", "."], repo);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], repo);
  return repo;
}

function addWorktree(repo: string, worktree: string, branch: string): void {
  mkdirSync(join(worktree, ".."), { recursive: true });
  git(["worktree", "add", "-b", branch, worktree], repo);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}
