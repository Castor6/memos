import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isReleasable } from "./ci.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(project, "node_modules/.bin/changeset");
const clipperPackage = "extensions/web-clipper/release/package.json";
const clipperChangelog = "extensions/web-clipper/release/CHANGELOG.md";
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
  const notes = new Map();
  for (const name of readdirSync(join(root, ".changeset"))) {
    if (!note(`.changeset/${name}`)) continue;
    const content = readFileSync(join(root, ".changeset", name), "utf8");
    const match = content.match(/^---\r?\n((?:["']?memos-(?:personal|web-clipper)["']?: (?:patch|minor|major)\r?\n)+)---\r?\n\s*\S/);
    assert.ok(match, `Invalid release note: ${name}`);
    const packages = [...match[1].matchAll(/memos-(personal|web-clipper)/g)].map((entry) => entry[0]);
    assert.equal(new Set(packages).size, packages.length, `Duplicate package in release note: ${name}`);
    notes.set(`.changeset/${name}`, packages);
  }
  // Do not use `changeset status` here: its package-wide change heuristic would
  // require notes for docs-only PRs and depends on a local base branch. The
  // explicit note schema above and application paths below are our policy.
  const clipper = existsSync(join(root, clipperPackage)) ? JSON.parse(readFileSync(join(root, clipperPackage), "utf8")) : null;
  if (clipper) {
    assert.equal(clipper.name, "memos-web-clipper");
    assert.equal(clipper.private, true);
    assert.match(clipper.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  }
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
    const previousClipper = at(root, base, clipperPackage);
    if (previousClipper) {
      assert.ok(clipper, "Extension version metadata must not be removed");
      assert.equal(clipper.version, JSON.parse(previousClipper).version, "Only Version Packages PRs update the extension version");
    } else if (clipper) {
      assert.equal(clipper.version, "0.0.1", "Independent extension version starts at the unpublished Chromium-compatible placeholder");
    }
    assert.ok(!paths.includes(clipperChangelog), "Only Version Packages PRs update the extension CHANGELOG.md");
    const added = git(root, "diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", base, head).split("\0");
    assert.ok(paths.filter(note).every((path) => added.includes(path)), "Only Version Packages PRs consume existing release notes");
    if (paths.some((path) => isReleasable(path) && (!clipper || !path.startsWith("extensions/web-clipper/")))) {
      assert.ok(added.some((path) => notes.get(path)?.includes("memos-personal")), "Memos behavior changed: add a new memos-personal release note");
    }
    if (clipper && paths.some((path) => path.startsWith("extensions/web-clipper/") && isReleasable(path))) {
      assert.ok(added.some((path) => notes.get(path)?.includes("memos-web-clipper")), "Extension behavior changed: add a new memos-web-clipper release note");
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
    // A package's first release creates a previously untracked CHANGELOG.md.
    const expected = [...new Set([
      ...git(worktree, "diff", "--name-only", "--no-renames", "-z").split("\0"),
      ...git(worktree, "ls-files", "--others", "--exclude-standard", "-z").split("\0"),
    ].filter(Boolean))];
    assert.ok(expected.includes("package.json") || expected.includes(clipperPackage), "No pending release exists on main");
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
