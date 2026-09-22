import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classify, isReleasable, validateResults } from "./ci.mjs";

test("docs skip heavy jobs; workflow and version PRs check the application", () => {
  assert.deepEqual(classify(["docs/development.md"]), { frontend: false, web_clipper: false, backend: false, proto: false, upgrade: false, workflow: false });
  for (const result of [classify([".github/workflows/ci.yml"]), classify([], { versionPR: true }), classify([], { full: true })]) {
    assert.ok(result.frontend && result.web_clipper && result.backend && result.proto);
  }
  assert.ok(classify(["proto/api/v1/memo.proto"]).frontend);
  assert.ok(classify(["proto/api/v1/memo.proto"]).backend);
  assert.ok(classify(["store/db/sqlite/migration/0.31/00__change.sql"]).upgrade);
  assert.ok(classify(["store/db/sqlite/migration/0.31/00__change.sql"]).backend);
  assert.equal(classify(["web/README.md"]).frontend, false);
  assert.ok(classify(["web/tests/editor.test.tsx"]).frontend);
  assert.ok(classify(["scripts/pdf/render.mjs"]).frontend);
  assert.ok(classify(["scripts/pdf/render.mjs"]).upgrade);
  assert.ok(isReleasable("scripts/pdf/render.mjs"));
});

test("web clipper changes run independent checks and shipped files require release notes", () => {
  const shipped = ["src/popup/App.tsx", "src/popup/index.html", "public/_locales/zh_CN/messages.json", "assets/logo-rounded.png",
    "scripts/package.mjs", "scripts/package-release.py", "package.json", "pnpm-lock.yaml", "manifest.config.ts", "vite.config.ts", "tsconfig.json", ".env.example"];
  const testOnly = ["src/test/setup.ts", "src/test/fixtures.ts", "src/lib/__tests__/fixture.json", "src/lib/__tests__/capture.test.ts",
    "scripts/package.test.mjs", "scripts/test_package_release.py", "vitest.config.ts", "biome.json"];
  for (const relative of [...shipped, ...testOnly]) {
    const path = `extensions/web-clipper/${relative}`;
    assert.deepEqual(classify([path]), { frontend: false, web_clipper: true, backend: false, proto: false, upgrade: false, workflow: false }, path);
    assert.equal(isReleasable(path), shipped.includes(relative), path);
  }
  for (const relative of ["README.md", "AGENTS.md", "docs/RELEASING.md"]) {
    const path = `extensions/web-clipper/${relative}`;
    assert.equal(classify([path]).web_clipper, false, path);
    assert.equal(isReleasable(path), false, path);
  }
  assert.equal(classify(["web/src/App.tsx"]).web_clipper, false);
  assert.equal(classify([".node-version"]).web_clipper, true);
});

test("release notes are needed for shipped behavior, not docs and tests", () => {
  for (const path of ["web/src/App.tsx", "server/server.go", "go.sum", "scripts/Dockerfile", "proto/api/v1/memo.proto"]) assert.ok(isReleasable(path), path);
  for (const path of ["README.md", "web/tests/example.ts", "web/src/lib.test.ts", "server/server_test.go", "scripts/dev.py"]) assert.ok(!isReleasable(path), path);
});

test("gate rejects failed, cancelled, missing, and unexpectedly skipped jobs", () => {
  const good = { changes: { result: "success", outputs: { frontend: "true", web_clipper: "true", backend: "false", proto: "false", upgrade: "false" } }, infrastructure: { result: "success" },
    frontend: { result: "success" }, web_clipper: { result: "success" }, backend: { result: "skipped" }, proto: { result: "skipped" }, upgrade: { result: "skipped" } };
  validateResults(good);
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    assert.throws(() => validateResults({ ...good, frontend: { result } }));
    assert.throws(() => validateResults({ ...good, web_clipper: { result } }));
  }
  const skipped = { ...good, changes: { ...good.changes, outputs: { ...good.changes.outputs, web_clipper: "false" } }, web_clipper: { result: "skipped" } };
  validateResults(skipped);
  for (const result of ["failure", "cancelled", undefined]) assert.throws(() => validateResults({ ...skipped, web_clipper: { result } }));
  for (const flag of [undefined, "", "yes"]) {
    assert.throws(() => validateResults({ ...good, changes: { ...good.changes, outputs: { ...good.changes.outputs, web_clipper: flag } } }));
  }
  assert.throws(() => validateResults({ ...good, changes: { ...good.changes, result: "failure" } }));
  assert.throws(() => validateResults({ ...good, infrastructure: { result: "skipped" } }));
});

test("the web clipper workflow is routed into the required gate with its own toolchain", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /web_clipper: \$\{\{ steps\.plan\.outputs\.web_clipper \}\}/);
  assert.match(ci, /\n  web_clipper:\s+needs: changes\s+if: needs\.changes\.outputs\.web_clipper == 'true'\s+uses: \.\/\.github\/workflows\/web-clipper-tests\.yml/);
  const gate = ci.slice(ci.indexOf("\n  validate:"));
  assert.match(gate, /if: always\(\)/);
  assert.match(gate, /needs: \[[^\]\n]*\bweb_clipper\b[^\]\n]*\]/);
  assert.match(gate, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);

  const workflow = read(".github/workflows/web-clipper-tests.yml");
  const pkg = JSON.parse(read("extensions/web-clipper/package.json"));
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /working-directory: extensions\/web-clipper/);
  assert.match(workflow, /package_json_file: extensions\/web-clipper\/package\.json/);
  assert.ok(workflow.includes(`version: ${pkg.packageManager.split("@")[1]}`));
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /cache-dependency-path: extensions\/web-clipper\/pnpm-lock\.yaml/);
  for (const command of ["pnpm install --frozen-lockfile", "cp .env.example .env", "pnpm lint", "pnpm test", "pnpm build"]) {
    assert.ok(workflow.includes(`run: ${command}`), command);
  }
  assert.match(workflow, /run: python3 -m unittest discover -s scripts -p 'test_package\*\.py'/);
  assert.match(workflow, /working-directory: \.\s+run: python3 extensions\/web-clipper\/scripts\/package-release\.py --output build\/clipper-ci/);
  assert.match(workflow, /uses: actions\/upload-artifact@v7/);
  assert.match(workflow, /path: build\/clipper-ci\/\s+if-no-files-found: error/);
  assert.doesNotMatch(workflow, /secrets\.|continue-on-error/);
});
