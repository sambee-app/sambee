# Archive Semantics V2

V2 is the only archive contract. Creation and extraction are durable operation
resources. Inspection and member reads are request-scoped and non-durable.
Extraction uses S1 live, source-owned processing: it has no manifest, resumable
checkpoint, member ledger, source snapshot, or replay state. Creation remains a
separate ledger-based workflow outside S1's extraction scope.

## Versioning And Encoding

Every durable operation, direct-local session, frontend recovery handle, and
Companion capability is pinned to `contract_version: "v2"`. A missing,
different, expired, or tampered version is rejected before lifecycle processing,
checkpoint parsing, or archive I/O.

JSON object members use the schema names in `schema.json`. Unknown object keys
are rejected unless the schema explicitly permits map entries. Member paths are
UTF-8, forward-slash-separated relative paths, at most 4096 characters, with no
leading slash, empty, `.` or `..` segment, colon, backslash, or NUL. Timestamps
are RFC 3339 UTC strings ending in `Z`, or `null` only where a source timestamp
is unavailable. Counts and byte sizes are non-negative integers. Inspection
pages contain 1 through 500 items.

ZIP DOS date fields have no timezone. Both executors interpret these fields as
UTC. This deterministic fallback does not recover the original local timezone
of a third-party archive. Invalid or unavailable DOS dates produce a `null`
timestamp. Writers convert timezone-aware source timestamps to UTC before
encoding DOS fields; timezone-free source values use the same UTC fallback.
DOS fields retain their two-second precision.

An inspection entry state describes whether that entry can be activated.
Directories are always `readable` because they can be navigated. Files are
`blocked` when encrypted, `readable` when their bytes can be served by the
active owner, and otherwise `unavailable`.

## Durable Operations

`operation` is the prepare request and `operationRead` is the durable resource
representation. Only `create` and `extract` kinds exist. The lifecycle phase is
one of `prepared`, `accepted`, `streaming`, `awaiting_user_decision`,
`verifying`, `completed`, `cancelled`, or `failed`; the final three states are
terminal. A revision-bound transition, decision, or cancellation must match its
expected revision when supplied.

An extraction terminal summary contains only the checked aggregate counters
`members_processed`, `members_completed`, `members_skipped`, `members_failed`,
`files_extracted`, `directories_created`, `extracted_bytes`, and
`files_replaced`. It satisfies
`members_processed = members_completed + members_skipped + members_failed`.
It does not expose an archive-wide total-member count.

The optional checked counters `encrypted_members_skipped` and
`unsupported_compression_members_skipped` explain source-only skips. Missing
counters mean zero. Their sum cannot exceed `members_skipped`. Encryption takes
precedence when a member also has unsupported compression. Destination skips,
such as collision decisions, do not increase these reason counters.

## Extraction Checkpoints And Decisions

An extraction checkpoint has exactly `version` (integer `2`) and
`aggregate_counters`. It rejects manifests, source snapshots, member outcomes,
reader cursors, decisions, pending-decision payloads, delivery IDs, and every
replay or idempotency field. A legacy extraction checkpoint is incompatible and
its operation must terminate; it is never migrated or resumed.

The ZIP-owning executor holds one in-memory live source session containing its
pinned reader, current record, delivery sequence, aggregate counters, live
collision policy, and an optional current decision. `next-member` is the only
transition that reads the next ZIP record. Source-only rejections finalize one
known aggregate outcome without a delivery sequence or destination request.

For a destination write, the source accepts one transient result only after its
own stream validation completes. It verifies the source-session ID, delivery
sequence, and current phase before it changes the current record or aggregate.
Lost or uncertain destination outcomes terminalize without inventing a member
outcome. Collision and retry details remain only in the live source session;
the durable operation retains at most its awaiting-decision phase and revision.

A collision pending decision has `kind: "collision"` and carries one immutable
`source` snapshot and one immutable `target` snapshot captured when the
collision is detected. Each snapshot always contains `path`, `size`, and
`modified_at`; unavailable size or timestamp values are represented by `null`,
not omitted keys. A member write error is the separate `member_error` variant
and does not use collision snapshots. The retired `existing_files` and
`conflicts` envelope is not valid V2 payload data.

Creation checkpoints remain ledger-based and contain `version`, `manifest`,
`member_outcomes`, `decisions`, `pending_decision`, and `delivery_ids`. Creation
terminal outcomes are `directory` and `created`.

## Routes And Ownership

The complete binding inventory is `route-bindings.json`. Backend durable routes
are rooted at `/api/archive/v2/operations`; its inspection routes are rooted at
`/api/archive/v2/inspection`. Companion direct-local execution routes are rooted
at `/api/browse/{drive}/archive/v2/executions`. Mixed Companion execution uses
only `/api/browse/{drive}/archive/v2/relay/creation` and
`/api/browse/{drive}/archive/v2/relay/extraction`.

Public route names and payloads are operation-based. Active extraction relay
routes are rooted at `/relay/extraction/live`: the ZIP owner begins, supplies the
next current member, accepts its transient destination result, and reports the
final aggregate after end-of-directory. The disjoint relay bindings identify
whether the local drive supplies source data or receives output; they do not
expose a topology selector. SMB-to-SMB is backend-owned, local-to-local is
Companion-owned, and mixed topologies use a Companion relay over a backend-owned
durable operation.

The bindings file also lists retained superseded extraction paths so it covers
every registered route. Those paths return `410 Gone`; they do not accept a
manifest, member acknowledgement, completion, or failure command. New clients
must use the live extraction routes.

Inspection request schemas are owner-specific: backend SMB inspection requires
`connection_id`, while Companion local inspection derives its source identity
from the `{drive}` route parameter. Backend member inspection additionally
declares its supported preview viewport and screen parameters.

## Capabilities And Idempotency

A Companion capability is a signed, short-lived claim bound to the operation ID,
contract version, operation kind, resolved topology, relay binding, and scoped
source and destination roots. The backend validates every claim against the
durable operation before relay I/O. S1 extraction capabilities do not include a
manifest hash.

S1 extraction has no delivery ID, idempotency key, replay fingerprint, or result
receipt. Its source-session ID and delivery sequence are live fencing tokens for
the current record only. Creation retains its separate bounded delivery-ID map
and replay behavior.

## Error Vocabulary

Every V2 failure uses the `{ "code": string, "message": string }` error
envelope. Validation and control failures use these stable semantic codes:
`invalid_manifest`, `invalid_checkpoint`, `invalid_contract_version`,
`invalid_member_path`, `collision`, `partial_output`, `source_changed`,
`transport_failure`, `cancelled`, `idempotency_conflict`, `capability_invalid`,
`capability_version_mismatch`, `invalid_request`, `authentication_invalid`,
`authorization_denied`, `not_found`, `invalid_operation_state`, and
`operation_unavailable`. The error schema defines their bounded
machine-readable representation; transport status distinguishes malformed input
(`422`), unauthenticated or invalid capability (`401`), capability scope denial
(`403`), stale state or idempotency conflict (`409`), unavailable operation
controls (`405`), and failed dependency or I/O (`5xx`).

Durable operation reads retain `last_error_json` for compatibility and expose
the same parsed typed envelope as `last_error`. A failed operation always uses
one of the stable codes above; malformed legacy error state is projected as
`invalid_operation_state`.
