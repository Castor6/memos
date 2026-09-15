import assert from "node:assert/strict";
import test from "node:test";
import { classify, isReleasable, validateResults } from "./ci.mjs";

test("docs skip heavy jobs; workflow and version PRs check the application", () => {
  assert.deepEqual(classify(["docs/development.md"]), { frontend: false, backend: false, proto: false, upgrade: false, workflow: false });
  for (const result of [classify([".github/workflows/ci.yml"]), classify([], { versionPR: true })]) {
    assert.ok(result.frontend && result.backend && result.proto);
  }
  assert.ok(classify(["proto/api/v1/memo.proto"]).frontend);
  assert.ok(classify(["proto/api/v1/memo.proto"]).backend);
  assert.ok(classify(["store/db/sqlite/migration/0.31/00__change.sql"]).upgrade);
  assert.ok(classify(["web/tests/editor.test.tsx"]).frontend);
});

test("release notes are needed for shipped behavior, not docs and tests", () => {
  for (const path of ["web/src/App.tsx", "server/server.go", "go.sum", "scripts/Dockerfile", "proto/api/v1/memo.proto"]) assert.ok(isReleasable(path), path);
  for (const path of ["README.md", "web/tests/example.ts", "web/src/lib.test.ts", "server/server_test.go", "scripts/dev.py"]) assert.ok(!isReleasable(path), path);
});

test("gate rejects failed, cancelled, missing, and unexpectedly skipped jobs", () => {
  const good = { changes: { result: "success", outputs: { frontend: "true", backend: "false", proto: "false", upgrade: "false" } }, infrastructure: { result: "success" },
    frontend: { result: "success" }, backend: { result: "skipped" }, proto: { result: "skipped" }, upgrade: { result: "skipped" } };
  validateResults(good);
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    assert.throws(() => validateResults({ ...good, frontend: { result } }));
  }
  assert.throws(() => validateResults({ ...good, changes: { ...good.changes, result: "failure" } }));
  assert.throws(() => validateResults({ ...good, infrastructure: { result: "skipped" } }));
});
