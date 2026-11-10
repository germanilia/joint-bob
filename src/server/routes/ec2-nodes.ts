import { z } from "zod";
import { describeEc2Node, ec2LaunchSchema, ec2StatusSchema, launchEc2Node } from "../../ec2-nodes.js";
import { Feature, requireFeature, sendError } from "../http-auth.js";
import { app } from "../state.js";

// Creating cloud machines costs money and uses a stored credential, so it needs the same right as managing secrets.
app.use("/api/ec2-nodes", requireFeature(Feature.SECRETS_MANAGE));

function failure(response: Parameters<typeof sendError>[0], error: unknown): void {
  if (error instanceof z.ZodError) sendError(response, 400, error.issues[0]?.message ?? "Invalid request");
  else sendError(response, 502, error instanceof Error ? error.message : "AWS request failed");
}

app.post("/api/ec2-nodes", async (request, response) => {
  try { response.status(201).json(await launchEc2Node(ec2LaunchSchema.parse(request.body))); } catch (error) { failure(response, error); }
});

app.get("/api/ec2-nodes/:instanceId", async (request, response) => {
  try { response.json(await describeEc2Node(ec2StatusSchema.parse({ ...request.query, instanceId: request.params.instanceId }))); } catch (error) { failure(response, error); }
});
