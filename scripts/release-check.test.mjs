import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRelease } from "./release-check.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "memos-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release-test@example.invalid");
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const commit = () => { git("add", "."); git("commit", "-m", "test fixture"); return git("rev-parse", "HEAD"); };
  write("package.json", JSON.stringify({ name: "memos-personal", version: "0.0.0", private: true }, null, 2) + "\n");
  write(".gitignore", "node_modules\n");
  write(".changeset/config.json", readFileSync(join(project, ".changeset/config.json"), "utf8"));
  write("CHANGELOG.md", "# Changelog\n");
  symlinkSync(join(project, "node_modules"), join(root, "node_modules"), "dir");
  const base = commit();
  return { root, git, write, commit, base };
}
const note = (level, summary) => `---\n"memos-personal": ${level}\n---\n\n${summary}\n`;

test("ordinary docs pass; behavior changes require their own new note", (t) => {
  const f = fixture(t);
  f.write("README.md", "Documentation\n"); f.commit();
  checkRelease({ root: f.root, base: f.base });
  f.write("web/src/App.tsx", "export default 1;\n"); f.commit();
  assert.throws(() => checkRelease({ root: f.root, base: f.base }), /add a new/);
  f.write(".changeset/fix.md", note("patch", "Fix the application")); f.commit();
  checkRelease({ root: f.root, base: f.base });
  const releasedBase = f.git("rev-parse", "HEAD");
  f.write("web/src/App.tsx", "export default 2;\n"); f.commit();
  assert.throws(() => checkRelease({ root: f.root, base: releasedBase }), /add a new/);
});

test("ordinary PRs cannot manually bump versions", (t) => {
  const f = fixture(t);
  const pkg = JSON.parse(readFileSync(join(f.root, "package.json"), "utf8"));
  f.write("package.json", JSON.stringify({ ...pkg, version: "0.1.0" })); f.commit();
  assert.throws(() => checkRelease({ root: f.root, base: f.base }), /Only Version/);
});

test("two changesets aggregate into one minor version; forged version diffs fail", (t) => {
  const f = fixture(t);
  f.write(".changeset/one.md", note("patch", "Fix one issue")); f.commit();
  f.write(".changeset/two.md", note("minor", "Add one feature"));
  const base = f.commit();
  execFileSync(join(project, "node_modules/.bin/changeset"), ["version"], { cwd: f.root, stdio: "pipe" });
  f.commit();
  assert.equal(JSON.parse(readFileSync(join(f.root, "package.json"))).version, "0.1.0");
  const changelog = readFileSync(join(f.root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /Fix one issue/); assert.match(changelog, /Add one feature/);
  checkRelease({ root: f.root, base, versionPR: true });
  f.write("web/src/App.tsx", "unexpected change\n"); f.commit();
  assert.throws(() => checkRelease({ root: f.root, base, versionPR: true }), /file set differs/);
});
