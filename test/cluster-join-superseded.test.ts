import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyMembershipSnapshot, createMembershipCluster, createMembershipInvitation, prepareMembershipJoin, redeemMembershipInvitation } from "../src/cluster-membership.js";
import { clusterPublicKeyFingerprint } from "../src/cluster-identity.js";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const CLUSTER = "10000000-0000-4000-8000-000000000001";

test("a newer invitation replaces a join that never finished", () => {
  const a = new DatabaseSync(":memory:"), b = new DatabaseSync(":memory:");
  try {
    const localA = { nodeId: A, name: "Alpha", url: "http://127.0.0.1:4001" }, localB = { nodeId: B, name: "Beta", url: "http://127.0.0.1:4002" };
    createMembershipCluster(a, localA, { id: CLUSTER, name: "Home" });
    // The first attempt is prepared and then lost: the manager never hears of it.
    const lost = createMembershipInvitation(a, A, A, CLUSTER, 1, 1_000);
    const fingerprint = clusterPublicKeyFingerprint(lost.body.manager.publicKey);
    prepareMembershipJoin(b, localB, lost, fingerprint, "20000000-0000-4000-8000-000000000001", 1_000);

    const fresh = createMembershipInvitation(a, A, A, CLUSTER, 1, 2_000);
    const request = prepareMembershipJoin(b, localB, fresh, fingerprint, "20000000-0000-4000-8000-000000000002", 2_000);
    assert.equal(request.invitationId, fresh.body.invitationId);
    const pending = (b.prepare("SELECT invitation_id FROM cluster_v2_membership_joins WHERE cluster_id=?").all(CLUSTER) as Array<{ invitation_id: string }>).map((row) => row.invitation_id);
    assert.deepEqual(pending, [fresh.body.invitationId], "only the newer attempt is pending");

    // The same request again is still answered consistently.
    assert.deepEqual(prepareMembershipJoin(b, localB, fresh, fingerprint, "20000000-0000-4000-8000-000000000002", 2_000), request);

    applyMembershipSnapshot(b, B, redeemMembershipInvitation(a, A, request, fresh.secret, 2_000));
    assert.equal((b.prepare("SELECT count(*) AS count FROM cluster_v2_membership_joins").get() as { count: number }).count, 0);
    // A member is told so instead of starting over.
    const again = createMembershipInvitation(a, A, A, CLUSTER, 1, 3_000);
    assert.throws(() => prepareMembershipJoin(b, localB, again, fingerprint, "20000000-0000-4000-8000-000000000003", 3_000), /Already an active member/);
  } finally { a.close(); b.close(); }
});
