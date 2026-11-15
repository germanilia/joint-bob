# Cluster agent policy

A cluster's policy follows its shared projects, not the relay carrying a request. Two projects on one machine can have different restrictions. Unscoped resource inventory and unrelated projects do not inherit a transport relay's rules.

## Configure

On the cluster manager, open **Settings → Cluster → Policy & pools**. Block skills by name or use **Advanced policy** to edit per-agent resource settings, enabled resources, Guardian and conversation-summary policy. Other members see the policy read-only. Personal resource activation stays separate.

Select a known cluster member as an optional signed policy source. That machine publishes through the existing Relay policy controls. One publisher can supply several clusters. Source identity comes from verified cluster membership, never the current transport route. The manager cannot override an inherited resource block with a local enable. Guardian runs all applicable rule groups, even with local Guardian disabled or a conversation locally exempted. An inherited summary policy takes precedence over the local cluster layer; multiple clusters are considered in stable cluster-ID order.

The manager checks current members' protocol support before assigning policy. Members must be reachable for that check. Policy-bearing invitations require the new policy protocol, including invitations issued before policy was added. Signed updates and existing hub catch-up distribute assignments and source publications. Cached verified source policy remains effective during disconnection; missing, invalid or removed configured sources stop execution visibly.

## Resource enforcement

Resource restrictions require strict resource isolation. A harness that cannot enforce the policy stops before launch rather than silently weakening it. Antigravity cannot enforce cluster resource restrictions. Required MCP servers and plugins must be available to the selected harness; policy does not grant website credentials, MCP authentication or permission to another account's resources.

Enforced skills carry content digests. Execution prepares private, digest-addressed copies, fetching authorized bundles from the configured source over the signed machine channel when needed. Bundles are checked against the policy digest before installation. Copies remain separate from installed skills and from other projects' versions. A native or scoped skill with the same name cannot substitute for the required copy. A changed source file needs a new policy publication.

## Mandatory pools

The same tab controls [mandatory cluster subscription pools](provider-profiles.md#mandatory-cluster-pools). Pool owners grant access on the credential host; managers choose from authorized pools. A grant is host-local and never replicated as credential data. Revocation is checked at the host for each proxied model request. Removing access or losing the host fails closed while the mandatory assignment remains set.

Cluster pools override personal and pinned automation choices. When multiple clusters supply pools, the first by cluster ID is selected for the turn; retries never move to a different cluster's pool or to ambient credentials. Alternative transport routes remain usable without changing the policy, membership or credential host.

This implementation does not migrate live project shares, replay webhooks or change a running installation's cluster settings. Deployment and live verification are separate operations.
