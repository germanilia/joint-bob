import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { awsAccountCredentials } from "./secrets.js";

const run = promisify(execFile);

const UBUNTU_AMI = "resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";
// The installer must run as the service user, not root (README: "Do not use sudo").
const USER_DATA = `#cloud-config
package_update: true
packages: [ca-certificates, curl]
runcmd:
  - [loginctl, enable-linger, ubuntu]
  - [su, -, ubuntu, -c, "curl -fsSL https://raw.githubusercontent.com/iliagerman/joint-bob/main/scripts/install.sh | bash"]
`;

export const ec2LaunchSchema = z.object({
  accountId: z.string().min(1).max(100),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "Enter an AWS region such as us-east-1"),
  instanceType: z.string().regex(/^[a-z0-9]+\.[a-z0-9]+$/, "Enter an instance type such as t3.medium").default("t3.medium"),
  name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9 ._-]+$/, "Use letters, digits, spaces, dots, dashes and underscores").default("joint-bob-node"),
  // Without these the instance has no way in: no key pair to SSH with and no inbound rule. Both belong to the person's own AWS account.
  keyName: z.string().regex(/^[A-Za-z0-9 ._@:/=+-]{1,255}$/, "Enter the name of an existing EC2 key pair").optional(),
  securityGroupId: z.string().regex(/^sg-[0-9a-f]{8,17}$/, "Enter a security group ID such as sg-0123456789abcdef0").optional(),
}).strict();
export const ec2StatusSchema = z.object({
  accountId: z.string().min(1).max(100),
  region: ec2LaunchSchema.shape.region,
  instanceId: z.string().regex(/^i-[0-9a-f]{8,17}$/),
}).strict();

export interface Ec2Node { instanceId: string; state: string; publicIp: string | null }

/** Runs the AWS CLI with only the chosen account's keys. Nothing else from this process's environment is passed on
    except what the CLI needs to start, so another attached account's keys can never be used by mistake. */
async function aws(accountId: string, region: string, args: string[]): Promise<unknown> {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...awsAccountCredentials(accountId), AWS_REGION: region, AWS_PAGER: "" };
  try {
    const { stdout } = await run("aws", [...args, "--region", region, "--output", "json"], { env, timeout: 60_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    // The CLI's first stderr line names the AWS error; the command line itself never carries a key.
    throw new Error(stderr?.trim().split("\n")[0] || (error as Error).message.split("\n")[0]);
  }
}

/** Starts an Ubuntu instance that installs Joint Bob on first boot. Joint Bob opens no inbound port itself: reaching the
    node needs the key pair and security group the person names, and its administrator and pairing are still done by a person. */
export async function launchEc2Node(input: z.infer<typeof ec2LaunchSchema>): Promise<Ec2Node> {
  const result = await aws(input.accountId, input.region, [
    "ec2", "run-instances", "--image-id", UBUNTU_AMI, "--instance-type", input.instanceType, "--count", "1",
    "--metadata-options", "HttpEndpoint=enabled,HttpTokens=required",
    "--block-device-mappings", "DeviceName=/dev/sda1,Ebs={VolumeSize=24,VolumeType=gp3,Encrypted=true}",
    "--tag-specifications", `ResourceType=instance,Tags=[{Key=Name,Value=${input.name}},{Key=ManagedBy,Value=joint-bob}]`,
    "--user-data", USER_DATA,
    ...(input.keyName ? ["--key-name", input.keyName] : []),
    ...(input.securityGroupId ? ["--security-group-ids", input.securityGroupId] : []),
  ]) as { Instances: Array<{ InstanceId: string; State: { Name: string } }> };
  const instance = result.Instances[0];
  return { instanceId: instance.InstanceId, state: instance.State.Name, publicIp: null };
}

export async function describeEc2Node(input: z.infer<typeof ec2StatusSchema>): Promise<Ec2Node> {
  const result = await aws(input.accountId, input.region, ["ec2", "describe-instances", "--instance-ids", input.instanceId]) as
    { Reservations: Array<{ Instances: Array<{ InstanceId: string; State: { Name: string }; PublicIpAddress?: string }> }> };
  const instance = result.Reservations[0].Instances[0];
  return { instanceId: instance.InstanceId, state: instance.State.Name, publicIp: instance.PublicIpAddress ?? null };
}
