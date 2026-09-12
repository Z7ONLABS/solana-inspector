import type { SolanaInspectionTransaction } from "./inspection-types";

const EVIDENCE_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
  exact_duplicate_observation:
    "This canonical raw record repeats an earlier observation. Keep its original reference for traceability; do not count its economic effects again. Caller-provided hashes do not override content comparison.",
  conflicting_transaction_revision:
    "Resolve the conflicting execution records for this supplied signature using independently corroborated original evidence. Do not choose a revision by its preferred outcome; every revision stays excluded from economic totals until the conflict is resolved.",
  transaction_identity_unavailable:
    "Supply the original transaction identity with its execution record. File order, matching quantities or a made-up signature cannot establish which chain transaction this observation represents.",
  finality_unavailable:
    "Independent verification of this transaction and its finality against the chain. User-supplied JSON and matching file hashes do not provide that verification.",
  transaction_order_unproven:
    "Verifiable block position and transaction ordering context. An input-array position or a caller-added transaction index is not sufficient.",
  economic_instruction_order_unproven:
    "Ordered outer and inner instruction references, invocation relationships and reconciled effects for each relevant account. Ambiguous overlapping events must remain blocked.",
  unexplained_balance_change:
    "Complete before/after observations, relevant inner instructions and account lifecycle evidence for the affected accounts, sufficient to explain the quantity difference without inventing a transfer or fee.",
  token_2022_unsupported:
    "Supported instruction semantics and historical Token-2022 extension configuration, including any transfer-hook effects and reconciled account quantities. Current account state is not historical proof.",
  token_2022_extension_state_unproven:
    "Historical Token-2022 extension configuration and evidence of any transfer-hook effects at the transaction time. A balance difference alone does not establish a fee.",
  token_2022_transfer_difference_unexplained:
    "Historical Token-2022 extension and hook evidence explaining the indicated amount, actual debit and actual credit separately. Do not assume the difference is a fee.",
  token_2022_transfer_effect_unproven:
    "The Token-2022 instruction, historical extension configuration, hook effects, account ownership and endpoint balances needed to reconcile its actual effects.",
  instruction_effect_unsupported:
    "Official instruction semantics for the observed program and variant, together with its relevant invocation, account lifecycle and balance effects. A program name or router label alone is insufficient.",
  token_account_owner_unknown:
    "Historical ownership evidence for the affected token account during this transaction. Current ownership or a close-authority label is not sufficient.",
  token_transfer_owner_unknown:
    "Historical ownership evidence for the source and destination token accounts at the transfer time. Do not infer a shared wallet owner from the transfer itself.",
  token_account_owner_changed:
    "Ordered authority-change instructions and before/after ownership evidence delimiting each account ownership period. Close authority must remain separate from owner.",
  block_time_unavailable:
    "An independently supported historical timestamp for this transaction. Do not substitute the current time or infer an execution time from file order.",
});

/** Guidance is additive: it does not remove blockers, change states or admit evidence. */
export function inspectionRequirements(
  codes: readonly string[],
): SolanaInspectionTransaction["requirements"] {
  return [...new Set(codes)].map((code) => ({
    code,
    neededEvidence: Object.hasOwn(EVIDENCE_BY_CODE, code)
      ? EVIDENCE_BY_CODE[code]
      : "Review the original instructions, account references, historical ownership, lifecycle and before/after balances to establish this effect. No specific resolution is established for this blocker; do not guess missing evidence.",
  }));
}
