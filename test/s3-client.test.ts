import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { awsProfileCredentials, deleteS3Object, forgetAwsProfileCredentials, putS3Bytes, putS3Object, S3Error, s3ObjectUrl, signS3Request } from "../src/s3-client.js";

// The worked examples of "Signature Calculations for the Authorization Header: Transferring Payload
// in a Single Chunk" in the Amazon S3 API reference: its example key, its date, its signatures.
const example = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const at = new Date("2013-05-24T00:00:00Z");
const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const signature = (headers: Record<string, string>): string => /Signature=([0-9a-f]{64})$/.exec(headers.authorization)![1];

test("requests are signed as Amazon's own examples are", () => {
  const sign = (method: string, url: string, headers: Record<string, string>, payloadHash = empty) =>
    signS3Request({ method, url: new URL(url), headers, payloadHash, credentials: example, region: "us-east-1", now: at });

  const get = sign("GET", "https://examplebucket.s3.amazonaws.com/test.txt", { Range: "bytes=0-9" });
  assert.equal(get.authorization, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(get["x-amz-date"], "20130524T000000Z");

  const body = "Welcome to Amazon S3.";
  const put = sign("PUT", "https://examplebucket.s3.amazonaws.com/test$file.text", { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, createHash("sha256").update(body).digest("hex"));
  assert.equal(signature(put), "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  assert.match(put.authorization, /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,/);

  assert.equal(signature(sign("GET", "https://examplebucket.s3.amazonaws.com/?lifecycle", {})), "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
  assert.equal(signature(sign("GET", "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", {})), "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

test("a session token is sent and signed", () => {
  const headers = signS3Request({ method: "DELETE", url: new URL("https://b.s3.eu-west-1.amazonaws.com/k"), payloadHash: empty, credentials: { ...example, sessionToken: "token" }, region: "eu-west-1", now: at });
  assert.equal(headers["x-amz-security-token"], "token");
  assert.match(headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
  assert.match(headers.authorization, /Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/eu-west-1\/s3\/aws4_request/);
});

test("an object's address: the bucket as the host, or in the path when its name or the service calls for it", () => {
  assert.equal(s3ObjectUrl({ bucket: "backups", region: "eu-west-1" }, "a b/שיחה+1.tar.gz").href, "https://backups.s3.eu-west-1.amazonaws.com/a%20b/%D7%A9%D7%99%D7%97%D7%94%2B1.tar.gz");
  assert.equal(s3ObjectUrl({ bucket: "my.backups", region: "us-east-1" }, "k").href, "https://s3.us-east-1.amazonaws.com/my.backups/k");
  assert.equal(s3ObjectUrl({ bucket: "b", region: "us-east-1", endpoint: "http://127.0.0.1:9000/" }, "p/k").href, "http://127.0.0.1:9000/b/p/k");
});

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }

/** A stand-in for the service: checks the signature the way the service does, with the same secret, and answers as told. */
async function service(answer: (seen: Seen) => { status: number; body?: string; headers?: Record<string, string> }): Promise<{ endpoint: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry: Seen = { method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks) };
      seen.push(entry);
      const authorization = String(request.headers.authorization);
      const signedNames = /SignedHeaders=([^,]+),/.exec(authorization)![1].split(";").filter((name) => name !== "host" && !name.startsWith("x-amz-"));
      const again = signS3Request({
        method: entry.method, url: new URL(entry.url, `http://${request.headers.host}`),
        headers: Object.fromEntries(signedNames.map((name) => [name, String(request.headers[name])])),
        payloadHash: String(request.headers["x-amz-content-sha256"]), credentials: example, region: "eu-central-1",
        now: new Date(String(request.headers["x-amz-date"]).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z")),
      });
      const bodyMatches = createHash("sha256").update(entry.body).digest("hex") === request.headers["x-amz-content-sha256"];
      const reply = again.authorization !== authorization ? { status: 403, body: "<Error><Code>SignatureDoesNotMatch</Code><Message>The signature does not match.</Message></Error>" }
        : !bodyMatches ? { status: 400, body: "<Error><Code>XAmzContentSHA256Mismatch</Code><Message>The body does not match.</Message></Error>" }
        : answer(entry);
      response.writeHead(reply.status, reply.headers ?? {});
      response.end(reply.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test("a file is uploaded whole with its length and hash, an object is deleted, and a refusal says what the service said", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-s3-"));
  let refuse: { status: number; body?: string; headers?: Record<string, string> } | undefined;
  const fake = await service((seen) => refuse ?? { status: seen.method === "DELETE" ? 204 : 200 });
  try {
    const target = { bucket: "backups", region: "eu-central-1", endpoint: fake.endpoint };
    const file = path.join(root, "one.tar.gz");
    const content = Buffer.alloc(700_000, 7);
    await writeFile(file, content);

    await putS3Object(target, example, "mac/Joint Bob/2026-11-11_claude_1.tar.gz", file, "application/gzip");
    const put = fake.seen.at(-1)!;
    assert.equal(put.method, "PUT");
    assert.equal(put.url, "/backups/mac/Joint%20Bob/2026-11-11_claude_1.tar.gz");
    assert.equal(put.headers["content-length"], String(content.length));
    assert.equal(put.headers["transfer-encoding"], undefined);
    assert.equal(put.headers["content-type"], "application/gzip");
    assert.deepEqual(put.body, content);

    await putS3Bytes(target, example, "mac/check.txt", Buffer.from("check"));
    assert.equal(fake.seen.at(-1)!.body.toString(), "check");

    await deleteS3Object(target, example, "mac/check.txt");
    assert.equal(fake.seen.at(-1)!.method, "DELETE");
    refuse = { status: 404, body: "<Error><Code>NoSuchKey</Code></Error>" };
    await deleteS3Object(target, example, "mac/already-gone.txt");

    refuse = { status: 403, body: "<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>" };
    await assert.rejects(putS3Object(target, example, "k", file), (error: unknown) => error instanceof S3Error && error.status === 403 && error.code === "AccessDenied" && /Writing k in bucket backups was refused: 403 AccessDenied \(Access Denied\)\./.test(error.message));
    await assert.rejects(deleteS3Object(target, example, "k"), /Deleting k in bucket backups was refused: 403 AccessDenied/);
    refuse = { status: 301, body: "<Error><Code>PermanentRedirect</Code></Error>", headers: { "x-amz-bucket-region": "us-west-2" } };
    await assert.rejects(putS3Bytes(target, example, "k", Buffer.from("x")), /The bucket is in region us-west-2\./);

    // A wrong secret is refused by the service, as it would be by the real one.
    refuse = undefined;
    await assert.rejects(putS3Bytes(target, { ...example, secretAccessKey: "wrong" }, "k", Buffer.from("x")), /403 SignatureDoesNotMatch/);
    await assert.rejects(putS3Object(target, example, "k", path.join(root, "missing.tar.gz")), { code: "ENOENT" });
  } finally { await fake.close(); await rm(root, { recursive: true, force: true }); }
});

test("a profile's credentials come from the AWS command line tool and are kept until they are about to expire", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-aws-"));
  const previous = process.env.PATH;
  try {
    const calls = path.join(root, "calls");
    await writeFile(path.join(root, "aws"), `#!/bin/sh
echo "$@" >> "${calls}"
case "$*" in
  *"--profile broken"*) echo "The config profile (broken) could not be found" >&2; exit 255;;
  *"--profile sela"*) echo '{"Version":1,"AccessKeyId":"AKIAPROFILE","SecretAccessKey":"secret","SessionToken":"session","Expiration":"2030-01-01T01:00:00Z"}';;
  *) echo '{"Version":1,"AccessKeyId":"AKIADEFAULT","SecretAccessKey":"secret"}';;
esac
`);
    await chmod(path.join(root, "aws"), 0o755);
    process.env.PATH = `${root}${path.delimiter}${previous ?? ""}`;
    forgetAwsProfileCredentials();
    const now = Date.parse("2030-01-01T00:00:00Z");
    assert.deepEqual(await awsProfileCredentials("sela", now), { accessKeyId: "AKIAPROFILE", secretAccessKey: "secret", sessionToken: "session" });
    await awsProfileCredentials("sela", now + 54 * 60_000);
    const { readFile } = await import("node:fs/promises");
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1, "kept while more than five minutes remain");
    await awsProfileCredentials("sela", now + 56 * 60_000);
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2, "asked again when they are about to expire");
    assert.deepEqual(await awsProfileCredentials("", now), { accessKeyId: "AKIADEFAULT", secretAccessKey: "secret" });
    assert.match((await readFile(calls, "utf8")).trim().split("\n").at(-1)!, /^configure export-credentials --format process$/);
    await assert.rejects(awsProfileCredentials("broken", now), /gave no credentials for profile broken: The config profile \(broken\) could not be found/);
  } finally { process.env.PATH = previous; forgetAwsProfileCredentials(); await rm(root, { recursive: true, force: true }); }
});
