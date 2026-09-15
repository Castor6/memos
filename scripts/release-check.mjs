import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isReleasable } from "./ci.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(project, "node_modules/.bin/changeset");
const note = (path) => /^\.changeset\/[^/]+\.md$/.test(path) && path !== ".changeset/README.md";
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const files = (root, base, head) => git(root, "diff", "--name-only", "--no-renames", "-z", base, head).split("\0").filter(Boolean);

function at(root, ref, path) {
  try { return git(root, "show", `${ref}:${path}`); }
  catch (error) {
    if (git(root, "ls-tree", ref, "--", path).trim() === "") return null;
    throw error;
  }
}

export function checkRelease({ root = process.cwd(), base = "", head = "HEAD", versionPR = false } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "memos-personal");
  assert.equal(pkg.private, true, "Version metadata must never become an npm publication");
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  for (const name of readdirSync(join(root, ".changeset"))) {
    if (!note(`.changeset/${name}`)) continue;
    const content = readFileSync(join(root, ".changeset", name), "utf8");
    assert.match(content, /^---\r?\n["']?memos-personal["']?: (patch|minor|major)\r?\n---\r?\n\s*\S/, `Invalid release note: ${name}`);
  }
  // Do not use `changeset status` here: its package-wide change heuristic would
  // require notes for docs-only PRs and depends on a local base branch. The
  // single-package note schema above and application paths below are our policy.
  if (!base) return;
  const paths = files(root, base, head);
  const previous = at(root, base, "package.json");
  if (!previous) {
    assert.ok(!versionPR, "Version PR needs initialized metadata on main");
    assert.equal(pkg.version, "0.0.0", "Bootstrap must start at the unpublished placeholder");
    return;
  }
  if (!versionPR) {
    assert.equal(pkg.version, JSON.parse(previous).version, "Only Version Packages PRs update the version");
    assert.ok(!paths.includes("CHANGELOG.md"), "Only Version Packages PRs update CHANGELOG.md");
    const added = git(root, "diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", base, head).split("\0");
    assert.ok(paths.filter(note).every((path) => added.includes(path)), "Only Version Packages PRs consume existing release notes");
    if (paths.some(isReleasable)) {
      assert.ok(added.some(note), "Shipped behavior changed: add a new .changeset/*.md release note");
    }
    return;
  }

  // Rebuild the entire expected version diff from main. A branch name alone never
  // grants permission to smuggle application, dependency, or workflow changes.
  const scratch = mkdtempSync(join(tmpdir(), "memos-version-check-"));
  const worktree = join(scratch, "source");
  try {
    git(root, "worktree", "add", "--detach", worktree, base);
    symlinkSync(join(project, "node_modules"), join(worktree, "node_modules"), "dir");
    execFileSync(cli, ["version"], { cwd: worktree, stdio: "pipe", encoding: "utf8" });
    const expected = git(worktree, "diff", "--name-only", "--no-renames", "-z").split("\0").filter(Boolean);
    assert.ok(expected.includes("package.json"), "No pending release exists on main");
    assert.deepEqual([...paths].sort(), expected.sort(), "Version PR file set differs from Changesets output");
    for (const path of expected) {
      const generated = existsSync(join(worktree, path)) ? readFileSync(join(worktree, path), "utf8") : null;
      assert.equal(at(root, head, path), generated, `Version PR has unexpected content: ${path}`);
    }
  } finally {
    if (existsSync(worktree)) git(root, "worktree", "remove", "--force", worktree);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkRelease({ base: process.env.RELEASE_BASE ?? process.argv[2] ?? "", head: process.env.RELEASE_HEAD ?? "HEAD", versionPR: process.env.VERSION_PR === "true" });
  console.log("Release metadata and changesets passed.");
}
