import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { openNodeDatabase } from "../src/node-database.js";

type Fixture = { accountId: string; otherId: string; log: string; ec2: typeof import("../src/ec2-nodes.js") };
// secrets.ts is reached through ec2-nodes.ts by a bare import, so every test here shares one instance pinned to one data dir.
let dir = "";
let fixture: Fixture;
const previous = { data: process.env.PI_WEB_DATA_DIR, path: process.env.PATH, key: process.env.JOINT_BOB_SECRET_KEY };

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ec2-"));
  process.env.PI_WEB_DATA_DIR = dir;
  process.env.JOINT_BOB_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  const database = openNodeDatabase(path.join(dir, "node.db"));
  database.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT); CREATE TABLE project_aliases (alias_id TEXT PRIMARY KEY, project_id TEXT);");
  database.close();
  const secrets = await import("../src/secrets.js");
  const aws = await secrets.saveSecretAccount({ label: "AWS test", provider: "aws", variables: [{ name: "AWS_ACCESS_KEY_ID", kind: "value", value: "AKIATESTKEY" }, { name: "AWS_SECRET_ACCESS_KEY", kind: "value", value: "test-secret" }] });
  const other = await secrets.saveSecretAccount({ label: "GitHub test", provider: "github", variables: [{ name: "GH_TOKEN", kind: "value", value: "ghp_test" }] });
  // A stand-in `aws` that records what it was given and answers like the real CLI.
  const log = path.join(dir, "aws.log");
  await writeFile(path.join(dir, "aws"), `#!/bin/sh
echo "ARGS $*" >> "${log}"
echo "KEY $AWS_ACCESS_KEY_ID SECRET $AWS_SECRET_ACCESS_KEY REGION $AWS_REGION LEAK $GH_TOKEN" >> "${log}"
case "$*" in
  *run-instances*) echo '{"Instances":[{"InstanceId":"i-0abc1234def567890","State":{"Name":"pending"}}]}' ;;
  *i-0abc1234def567890*) echo '{"Reservations":[{"Instances":[{"InstanceId":"i-0abc1234def567890","State":{"Name":"running"},"PublicIpAddress":"203.0.113.9"}]}]}' ;;
  *) echo "An error occurred (AuthFailure) when calling the X operation: bad" >&2; exit 254 ;;
esac
`);
  await chmod(path.join(dir, "aws"), 0o755);
  process.env.PATH = `${dir}:${previous.path}`;
  process.env.GH_TOKEN = "must-not-reach-aws";
  fixture = { accountId: aws.id, otherId: other.id, log, ec2: await import("../src/ec2-nodes.js") };
});

after(async () => {
  delete process.env.GH_TOKEN;
  for (const [name, value] of [["PI_WEB_DATA_DIR", previous.data], ["PATH", previous.path], ["JOINT_BOB_SECRET_KEY", previous.key]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

async function withFixture(body: (fixture: Fixture) => Promise<void>) { await body(fixture); }

test("launching an EC2 node uses only the chosen account's keys and opens no inbound access", async () => {
  await withFixture(async ({ accountId, log, ec2 }) => {
    const node = await ec2.launchEc2Node(ec2.ec2LaunchSchema.parse({ accountId, region: "us-east-1" }));
    assert.deepEqual(node, { instanceId: "i-0abc1234def567890", state: "pending", publicIp: null });
    const recorded = await readFile(log, "utf8");
    assert.match(recorded, /KEY AKIATESTKEY SECRET test-secret REGION us-east-1 LEAK \n/);
    assert.match(recorded, /ec2 run-instances .*--instance-type t3\.medium/);
    assert.match(recorded, /HttpTokens=required/);
    assert.match(recorded, /Encrypted=true/);
    assert.doesNotMatch(recorded, /security-group|0\.0\.0\.0/);
    assert.match(recorded, /install\.sh \| bash/);
    assert.doesNotMatch(recorded, /--key-name|--security-group-ids/);
    assert.doesNotMatch(recorded.split("\n")[0], /AKIATESTKEY|test-secret/);
  });
});

test("a named key pair and security group are passed through, and malformed ones are refused", async () => {
  await withFixture(async ({ accountId, log, ec2 }) => {
    await ec2.launchEc2Node(ec2.ec2LaunchSchema.parse({ accountId, region: "us-east-1", keyName: "my-key", securityGroupId: "sg-0123456789abcdef0" }));
    assert.match(await readFile(log, "utf8"), /--key-name my-key --security-group-ids sg-0123456789abcdef0/);
    assert.throws(() => ec2.ec2LaunchSchema.parse({ accountId, region: "us-east-1", securityGroupId: "default" }), /security group/);
    assert.throws(() => ec2.ec2LaunchSchema.parse({ accountId, region: "us-east-1", keyName: "a;b" }), /key pair/);
  });
});

test("an EC2 node's state and address are read back with the same account", async () => {
  await withFixture(async ({ accountId, ec2 }) => {
    const status = await ec2.describeEc2Node(ec2.ec2StatusSchema.parse({ accountId, region: "eu-west-1", instanceId: "i-0abc1234def567890" }));
    assert.deepEqual(status, { instanceId: "i-0abc1234def567890", state: "running", publicIp: "203.0.113.9" });
  });
});

test("only an AWS account can launch, and bad input and AWS errors are refused plainly", async () => {
  await withFixture(async ({ accountId, otherId, ec2 }) => {
    await assert.rejects(ec2.launchEc2Node(ec2.ec2LaunchSchema.parse({ accountId: otherId, region: "us-east-1" })), /Choose an AWS secret account/);
    assert.throws(() => ec2.ec2LaunchSchema.parse({ accountId, region: "not a region" }), /AWS region/);
    assert.throws(() => ec2.ec2LaunchSchema.parse({ accountId, region: "us-east-1", instanceType: "t3.medium; rm -rf" }), /instance type/);
    await assert.rejects(ec2.describeEc2Node(ec2.ec2StatusSchema.parse({ accountId, region: "us-east-1", instanceId: "i-0000000000000000" })), /^Error: An error occurred \(AuthFailure\)/);
  });
});
