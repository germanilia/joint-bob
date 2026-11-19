import assert from "node:assert/strict";
import test from "node:test";
import { isMachineLink, parseMachineLink, summarizeMachineLink } from "../src/server/machine-link.js";

const fingerprint = "a".repeat(64), secret = "s".repeat(43);
const bundle = (change: Record<string, unknown> = {}) => ({
  version: 1, issuer: { nodeId: "0b6cd0f4-7c1f-4d57-9a8a-2f6f0f7d3a10", name: "MacBook" }, own: true, expiresAt: Date.now() + 60_000,
  relays: [{ origin: "https://relay.example.com", link: `https://relay.example.com/enroll#${fingerprint}.${secret}` }],
  twins: [{ name: "MacBook", link: "https://mac.example.com/join#twin-v2.e30" }], clusters: [{ name: "Home", link: "https://mac.example.com/join#v2.x.e30" }], ...change,
});
const link = (value: unknown, origin = "https://mac.example.com") => `${origin}/join#machine-v1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

test("a machine link is recognised by its shape and summarised without its secrets", () => {
  const parsed = parseMachineLink(link(bundle()));
  assert.equal(isMachineLink(link(bundle())), true);
  assert.equal(isMachineLink("https://mac.example.com/join#twin-v2.e30"), false);
  const summary = summarizeMachineLink(parsed);
  assert.deepEqual(summary.relays, [{ origin: "https://relay.example.com", pass: true }]);
  assert.deepEqual([summary.issuer, summary.own, summary.twins, summary.clusters], ["MacBook", true, ["MacBook"], ["Home"]]);
  assert.equal(JSON.stringify(summary).includes(secret), false);
  // A machine reachable only through relays hands out links under its relay-only name.
  assert.equal(parseMachineLink(link(bundle(), "https://0b6cd0f4-7c1f-4d57-9a8a-2f6f0f7d3a10.relay.invalid")).issuer.name, "MacBook");
});

test("anything that is not a whole, well-formed machine link is refused", () => {
  const refused = (value: unknown) => assert.throws(() => parseMachineLink(value), /not a link for adding a machine/);
  refused(undefined);
  refused("not a link");
  refused("https://mac.example.com/join#twin-v2.e30");
  refused("http://mac.example.com/join#machine-v1.e30");
  refused(link(bundle()).replace("/join#", "/other#"));
  refused(`${link(bundle())}.extra`);
  refused(link(bundle({ version: 2 })));
  refused(link(bundle({ surprise: true })));
  refused(link(bundle({ issuer: { nodeId: "nope", name: "MacBook" } })));
  // A pass must be for the relay it is listed under, and a relay must be a bare HTTPS origin.
  refused(link(bundle({ relays: [{ origin: "https://relay.example.com", link: `https://other.example.com/enroll#${fingerprint}.${secret}` }] })));
  refused(link(bundle({ relays: [{ origin: "https://relay.example.com/path", link: null }] })));
  refused(link(bundle({ relays: [{ origin: "http://relay.example.com", link: null }] })));
  refused(link(bundle({ twins: Array.from({ length: 17 }, () => ({ name: "x", link: "y" })) })));
});
