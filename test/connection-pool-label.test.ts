import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

// Execute the browser's state mapping and label renderer without starting a browser.
const socket = readFileSync(new URL("../public/app/socket.js", import.meta.url), "utf8");
const transcript = readFileSync(new URL("../public/app/chat-transcript.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(`${socket.match(/const connectionState = [^\n]+/)![0]}
${transcript.match(/function connectionLabel\(connection\) \{[\s\S]*?\n\}/)![0]}
this.label = payload => connectionLabel(connectionState(payload));`, context);

test("live and reconnect connection payloads retain pool host and sharing cluster", () => {
  assert.equal(context.label({ pool: { name: "contigos", nodeName: "Homeserver", clusterName: "Contigos" }, profile: { label: "codex" } }),
    "node Homeserver · cluster Contigos · pool contigos · profile codex");
});

test("local pools omit the cluster and older payloads still render", () => {
  assert.equal(context.label({ pool: { name: "personal", nodeName: "Mac" }, profile: { label: "codex" } }),
    "node Mac · pool personal · profile codex");
  assert.equal(context.label({ pool: { name: "old" }, profile: { label: "codex" } }), "pool old · profile codex");
  assert.equal(context.label({ profile: { label: "codex" } }), "profile codex");
});
