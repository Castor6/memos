import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Import the actual production entry and shared chunks without a DOM. Source tests
// resolve Node exports and cannot catch browser-only dependencies in the Vite output.
const dist = resolve(process.argv[2] ?? fileURLToPath(new URL("../dist", import.meta.url)));
const manifest = JSON.parse(await readFile(resolve(dist, "manifest.json"), "utf8"));
assert.equal(manifest.background?.type, "module");
assert.equal(typeof globalThis.document, "undefined");
assert.equal(typeof globalThis.window, "undefined");

const event = () => ({ addListener() {} });
const listeners = [];
const storage = new Map();
const api = {
  runtime: {
    id: "worker-smoke-test",
    onMessage: { addListener: (listener) => listeners.push(listener) },
    onInstalled: event(),
  },
  storage: {
    local: {
      async get(keys) {
        return Object.fromEntries(
          (typeof keys === "string" ? [keys] : keys).filter((key) => storage.has(key)).map((key) => [key, storage.get(key)]),
        );
      },
      async set(items) {
        for (const [key, value] of Object.entries(items)) storage.set(key, value);
      },
      async remove(keys) {
        for (const key of typeof keys === "string" ? [keys] : keys) storage.delete(key);
      },
      async setAccessLevel() {},
    },
    onChanged: event(),
  },
  i18n: { getMessage: () => "", getUILanguage: () => "en" },
  action: { onClicked: event(), async setTitle() {} },
  contextMenus: { onClicked: event(), async removeAll() {}, create() {} },
};
globalThis.browser = api;
globalThis.chrome = api;
globalThis.fetch = async () => {
  throw new Error("The worker startup check must not access the network");
};

const deadline = setTimeout(() => {
  console.error("Production worker startup or connection check timed out");
  process.exit(1);
}, 5_000);
try {
  await import(pathToFileURL(resolve(dist, manifest.background.service_worker)).href);
  assert.equal(listeners.length, 1, "The worker must register its message handler");
  const sender = { id: api.runtime.id, url: `chrome-extension://${api.runtime.id}/src/options/index.html` };
  const connection = await listeners[0]({ type: "GET_CONNECTION_STATE", refresh: true, source: "active" }, sender);
  assert.equal(connection.status, "disconnected");
  assert.equal(connection.source, null);
  assert.equal(await listeners[0]({ type: "GET_AUTH_USER" }, sender), null);
  const popup = await listeners[0]({ type: "GET_POPUP_STATE" }, { ...sender, url: sender.url.replace("options", "popup") });
  assert.equal(popup.status, "signed-out");
  console.log("Production worker starts without DOM and answers connection, auth and popup requests.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
