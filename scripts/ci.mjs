import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isReleasable(path) {
  if (/\.(md|test\.[cm]?[jt]sx?|spec\.[cm]?[jt]sx?)$/.test(path) || path.endsWith("_test.go")) return false;
  if (path.startsWith("web/tests/") || path.startsWith("store/test/")) return false;
  return path.startsWith("web/src/") || path.startsWith("web/public/") || path.startsWith("proto/") || path.startsWith("store/db/") ||
    path.endsWith(".go") || ["go.mod", "go.sum", "web/package.json", "web/pnpm-lock.yaml", "web/index.html",
      "web/vite.config.mts", "scripts/Dockerfile", "scripts/entrypoint.sh"].includes(path);
}

export function classify(paths, { full = false, versionPR = false } = {}) {
  const workflow = paths.some((path) => path.startsWith(".github/workflows/"));
  const all = full || versionPR || workflow;
  return {
    frontend: all || paths.some((path) => path.startsWith("web/") || path.startsWith("proto/") || path === ".node-version"),
    backend: all || paths.some((path) => path.endsWith(".go") || path.startsWith("proto/") || ["go.mod", "go.sum", ".golangci.yaml"].includes(path)),
    proto: all || paths.some((path) => path.startsWith("proto/") && !path.endsWith(".md")),
    upgrade: full || paths.some((path) => /^(store\/(db|migration)\/|store\/migrator\.go$|server\/server\.go$)/.test(path) ||
      ["scripts/Dockerfile", "scripts/entrypoint.sh", "scripts/release_smoke_test.sh", ".github/workflows/upgrade-smoke.yml"].includes(path)),
    workflow,
  };
}

export function validateResults(needs) {
  for (const required of ["changes", "infrastructure"]) {
    if (needs[required]?.result !== "success") throw new Error(`${required} did not succeed`);
  }
  for (const job of ["frontend", "backend", "proto", "upgrade"]) {
    const flag = needs.changes.outputs[job];
    if (!["true", "false"].includes(flag)) throw new Error(`${job}: missing change classification`);
    const required = flag === "true";
    const result = needs[job]?.result;
    if (required ? result !== "success" : !["success", "skipped"].includes(result)) {
      throw new Error(`${job}: expected ${required ? "success" : "success or skipped"}, got ${result}`);
    }
  }
}

function plan() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const branch = pr?.head.ref ?? process.env.GITHUB_REF_NAME;
  const sameRepo = !pr || pr.head.repo?.full_name === process.env.GITHUB_REPOSITORY;
  let versionPR = sameRepo && branch === "changeset-release/main";
  const base = pr?.base.sha ?? (manual ? "origin/main" : event.before);
  const head = pr?.head.sha ?? "HEAD";
  const missingBase = !base || /^0+$/.test(base);
  const full = missingBase || (manual && !versionPR);
  const paths = missingBase ? [] : execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, head], { encoding: "utf8" }).split("\0").filter(Boolean);
  // A merged version PR arrives as an ordinary push to main. Validate that push
  // against the same generated diff instead of rejecting its version update.
  if (!pr && !manual && !full && paths.includes("package.json")) {
    const hasBasePackage = execFileSync("git", ["ls-tree", base, "--", "package.json"], { encoding: "utf8" }).trim();
    if (hasBasePackage) {
      const before = JSON.parse(execFileSync("git", ["show", `${base}:package.json`], { encoding: "utf8" }));
      const after = JSON.parse(readFileSync("package.json", "utf8"));
      versionPR = before.version !== after.version;
    }
  }
  const outputs = { ...classify(paths, { full, versionPR }), base: missingBase ? "" : base, head, version_pr: versionPR };
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
  console.log(JSON.stringify({ paths, ...outputs }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "gate") validateResults(JSON.parse(process.env.NEEDS_JSON));
  else plan();
}
