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
  write(".changeset/changelog.mjs", readFileSync(join(project, ".changeset/changelog.mjs"), "utf8"));
  write("CHANGELOG.md", "# Changelog\n");
  symlinkSync(join(project, "node_modules"), join(root, "node_modules"), "dir");
  const base = commit();
  return { root, git, write, commit, base };
}
const note = (level, summary) => `---\n"memos-personal": ${level}\n---\n\n${summary}\n`;
const extensionNote = (level = "patch") => `---\n"memos-web-clipper": ${level}\n---\n\n更新浏览器扩展。\n`;

function enableClipper(f) {
  f.write("pnpm-workspace.yaml", 'packages:\n  - "."\n  - "extensions/web-clipper/release"\n');
  f.write("extensions/web-clipper/release/package.json", JSON.stringify({ name: "memos-web-clipper", version: "0.0.1", private: true }, null, 2) + "\n");
  return f.commit();
}

test("extension changes require their own note and cannot manually bump their version", (t) => {
  const f = fixture(t);
  const base = enableClipper(f);
  f.write("extensions/web-clipper/src/background.ts", "export default 1;\n");
  f.write(".changeset/app-only.md", note("patch", "更新应用")); f.commit();
  assert.throws(() => checkRelease({ root: f.root, base }), /memos-web-clipper release note/);
  f.write(".changeset/extension.md", extensionNote()); f.commit();
  checkRelease({ root: f.root, base });
  f.write("extensions/web-clipper/release/package.json", JSON.stringify({ name: "memos-web-clipper", version: "0.0.2", private: true })); f.commit();
  assert.throws(() => checkRelease({ root: f.root, base }), /Only Version Packages PRs update the extension version/);
});

test("Changesets independently versions the extension and exact regeneration protects both logs", (t) => {
  const f = fixture(t);
  enableClipper(f);
  f.write(".changeset/server.md", note("minor", "仅更新 Memos"));
  let base = f.commit();
  const generate = () => execFileSync(join(project, "node_modules/.bin/changeset"), ["version"], { cwd: f.root, stdio: "pipe" });
  const extensionVersion = () => JSON.parse(readFileSync(join(f.root, "extensions/web-clipper/release/package.json"))).version;
  generate(); f.commit();
  assert.equal(extensionVersion(), "0.0.1");
  checkRelease({ root: f.root, base, versionPR: true });
  f.write(".changeset/extension.md", extensionNote("minor"));
  f.write(".changeset/extension-fix.md", extensionNote("patch"));
  base = f.commit();
  generate(); f.commit();
  assert.equal(extensionVersion(), "0.1.0");
  assert.equal(JSON.parse(readFileSync(join(f.root, "package.json"))).version, "0.1.0");
  checkRelease({ root: f.root, base, versionPR: true });
  // The merged extension-only release must be recognized on main without routing Memos jobs.
  const eventPath = join(f.root, "event.json");
  const outputPath = join(f.root, "ci-output");
  writeFileSync(eventPath, JSON.stringify({ before: base }));
  execFileSync(process.execPath, [join(project, "scripts/ci.mjs")], { cwd: f.root, stdio: "pipe", env: {
    ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main", GITHUB_REPOSITORY: "Castor6/memos",
    GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
  } });
  const outputs = Object.fromEntries(readFileSync(outputPath, "utf8").trim().split("\n").map((line) => line.split("=")));
  assert.equal(outputs.version_pr, "true");
  assert.equal(outputs.web_clipper, "true");
  for (const job of ["frontend", "backend", "proto", "upgrade"]) assert.equal(outputs[job], "false", job);
  rmSync(eventPath); rmSync(outputPath);
  f.write("extensions/web-clipper/release/CHANGELOG.md", "篡改日志\n"); f.commit();
  assert.throws(() => checkRelease({ root: f.root, base, versionPR: true }), /unexpected content/);
});

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
  f.git("checkout", "--detach");
  f.git("branch", "-D", "main");
  checkRelease({ root: f.root, base, versionPR: true });
  // Exercise the real event planner for the post-merge push and for explicit
  // CI dispatches, including the base used to enforce version ownership.
  const eventDir = mkdtempSync(join(tmpdir(), "memos-ci-event-"));
  t.after(() => rmSync(eventDir, { recursive: true, force: true }));
  const eventPath = join(eventDir, "event.json");
  const outputPath = join(eventDir, "outputs");
  f.git("update-ref", "refs/remotes/origin/main", base);
  for (const [name, branch, event, expectedVersion, expectedBase] of [
    ["push", "main", { before: base }, true, base],
    ["workflow_dispatch", "changeset-release/main", {}, true, "origin/main"],
    ["workflow_dispatch", "feature/manual-check", {}, false, "origin/main"],
  ]) {
    writeFileSync(eventPath, JSON.stringify(event)); writeFileSync(outputPath, "");
    execFileSync(process.execPath, [join(project, "scripts/ci.mjs")], { cwd: f.root, stdio: "pipe", env: {
      ...process.env, GITHUB_EVENT_NAME: name, GITHUB_REF_NAME: branch, GITHUB_REPOSITORY: "Castor6/memos",
      GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
    } });
    const outputs = Object.fromEntries(readFileSync(outputPath, "utf8").trim().split("\n").map((line) => line.split("=")));
    assert.equal(outputs.version_pr, String(expectedVersion));
    assert.equal(outputs.base, expectedBase);
    assert.equal(outputs.frontend, "true");
  }
  f.write("web/src/App.tsx", "unexpected change\n"); f.commit();
  assert.throws(() => checkRelease({ root: f.root, base, versionPR: true }), /file set differs/);
});

test("multiline release notes generate clean whitespace and pass exact regeneration", (t) => {
  const f = fixture(t);
  f.write(".changeset/multiline.md", note("minor", "新增笔记功能。\n\n迁移核心字段，保留旧数据。\n\n- 第一项\n  - 嵌套项\n\n```text\n  保留代码缩进\n```"));
  const base = f.commit();
  execFileSync(join(project, "node_modules/.bin/changeset"), ["version"], { cwd: f.root, stdio: "pipe" });
  const changelog = readFileSync(join(f.root, "CHANGELOG.md"), "utf8");
  assert.doesNotMatch(changelog, /^[ \t]+$/m);
  assert.match(changelog, /新增笔记功能。\n\n  迁移核心字段，保留旧数据。/);
  assert.match(changelog, /    - 嵌套项/);
  assert.match(changelog, /    保留代码缩进/);
  f.git("diff", "--check", base);
  f.commit();
  checkRelease({ root: f.root, base, versionPR: true });
  f.write("CHANGELOG.md", changelog.replace("保留旧数据", "篡改生成结果")); f.commit();
  assert.throws(() => checkRelease({ root: f.root, base, versionPR: true }), /unexpected content/);
});


test("an extension note cannot cover Memos behavior; mixed releases version both packages", (t) => {
  const f = fixture(t);
  const initial = enableClipper(f);
  f.write("web/src/App.tsx", "export default 1;\n");
  f.write(".changeset/extension.md", extensionNote("minor")); f.commit();
  assert.throws(() => checkRelease({ root: f.root, base: initial }), /memos-personal release note/);
  f.write(".changeset/server.md", note("minor", "更新 Memos"));
  const base = f.commit();
  checkRelease({ root: f.root, base: initial });
  execFileSync(join(project, "node_modules/.bin/changeset"), ["version"], { cwd: f.root, stdio: "pipe" });
  f.commit();
  for (const path of ["package.json", "extensions/web-clipper/release/package.json"]) {
    assert.equal(JSON.parse(readFileSync(join(f.root, path))).version, "0.1.0");
  }
  checkRelease({ root: f.root, base, versionPR: true });
});
