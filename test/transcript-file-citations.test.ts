import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Exercise inline rendering without a browser; only the DOM operations it uses.
class Node {
  children: Node[] = [];
  dataset: Record<string, string> = {};
  href = "";
  constructor(public tagName: string, public textContent = "") {}
  append(...children: Node[]) { this.children.push(...children); }
  querySelectorAll() { return []; }
}

async function render(source: string, resolveFileUrl?: (path: string) => string) {
  const code = await readFile("public/markdown.js", "utf8");
  const context = vm.createContext({ URL, location: { origin: "http://localhost" }, document: {
    createElement: (tag: string) => new Node(tag),
    createTextNode: (text: string) => new Node("#text", text),
  } });
  vm.runInContext(code.replace(/export /g, ""), context);
  return context.inlineNodes(source, resolveFileUrl) as Node[];
}

test("Antigravity file citations use the project file resolver and retain their label", async () => {
  const paths: string[] = [];
  const nodes = await render("[claude.ts](file:///home/user/my%20project/src/guardian/claude.ts#L19)", path => {
    paths.push(path);
    return "/api/project/file";
  });
  assert.deepEqual(paths, ["/home/user/my project/src/guardian/claude.ts"]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].tagName, "a");
  assert.equal(nodes[0].dataset.filePath, paths[0]);
  assert.equal(nodes[0].href, "/api/project/file");
  assert.equal(nodes[0].children[0].children[0].textContent, "claude.ts");
});

test("file citations without a resolver show only the label; unsafe links remain inert", async () => {
  const nodes = await render("[check.ts](file:///tmp/check.ts#L69-L73)");
  assert.equal(nodes[0].children[0].textContent, "check.ts");
  for (const url of ["javascript:alert", "file://remote/tmp/check.ts", "file:///bad%ZZ.ts"]) {
    const result = await render(`[check.ts](${url})`, () => { throw new Error("must not resolve"); });
    assert.equal(result[0].tagName, "#text");
    assert.equal(result[0].textContent, `[check.ts](${url})`);
  }
});
