import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("publishing from an incomplete checkout preserves existing landing media", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "landing-publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "aws"), `#!/bin/sh
case " $* " in
  *' s3 sync '* )
    echo 'syncing landing media'
    case " $* " in *' --delete '*) echo 'publishing would delete media'; exit 1;; esac ;;
  *' describe-stacks '* ) echo 'fixture-output' ;;
esac
`, { mode: 0o755 });

  const publish = fileURLToPath(new URL("../promo-video/landing/publish.sh", import.meta.url));
  const result = spawnSync("sh", [publish], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.match(result.stdout, /syncing landing media/);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
