import { SOLANA_TOKEN_2022_PROGRAM } from "./normalize";
import type {
  NormalizedSolanaTransaction,
  SolanaRawMovement,
  SolanaTokenAccountBalance,
} from "./types";

/** A two-edge, newly initialized/closed conduit, not a general balance solver. */
function linearTemporaryProof(
  tx: NormalizedSolanaTransaction,
  movement: SolanaRawMovement,
  movements: readonly SolanaRawMovement[],
  accounts: ReadonlyMap<string, SolanaTokenAccountBalance>,
): boolean {
  for (const temporaryAddress of [movement.fromAccount, movement.toAccount]) {
    const temporary = accounts.get(temporaryAddress);
    const native = tx.accounts.find((a) => a.address === temporaryAddress);
    if (
      !temporary ||
      temporary.identityEvidence !== "instruction_lifecycle" ||
      temporary.programId !== SOLANA_TOKEN_2022_PROGRAM ||
      temporary.preRaw !== "0" ||
      temporary.postRaw !== "0" ||
      !temporary.preOwner ||
      temporary.preOwner !== temporary.postOwner ||
      native?.preLamports !== "0" ||
      native.postLamports !== "0"
    )
      continue;
    const touching = movements.filter(
      (m) =>
        m.asset.assetId === temporary.mint &&
        (m.fromAccount === temporaryAddress ||
          m.toAccount === temporaryAddress),
    );
    if (touching.length !== 2) continue;
    const incoming = touching.find((m) => m.toAccount === temporaryAddress);
    const outgoing = touching.find((m) => m.fromAccount === temporaryAddress);
    if (
      !incoming ||
      !outgoing ||
      incoming === outgoing ||
      incoming.rawAmount !== outgoing.rawAmount ||
      incoming.rawAmount !== movement.rawAmount ||
      incoming.fromAccount === outgoing.toAccount ||
      incoming.outerIndex !== outgoing.outerIndex ||
      incoming.innerIndex === null ||
      outgoing.innerIndex === null ||
      incoming.innerIndex >= outgoing.innerIndex
    )
      continue;
    const source = accounts.get(incoming.fromAccount);
    const destination = accounts.get(outgoing.toAccount);
    if (
      !source ||
      !destination ||
      source.mint !== temporary.mint ||
      destination.mint !== temporary.mint ||
      source.decimals !== temporary.decimals ||
      destination.decimals !== temporary.decimals ||
      source.preRaw === null ||
      source.postRaw === null ||
      destination.preRaw === null ||
      destination.postRaw === null ||
      !source.preOwner ||
      source.preOwner !== source.postOwner ||
      !destination.preOwner ||
      destination.preOwner !== destination.postOwner ||
      BigInt(source.preRaw) - BigInt(source.postRaw) !==
        BigInt(incoming.rawAmount) ||
      BigInt(destination.postRaw) - BigInt(destination.preRaw) !==
        BigInt(outgoing.rawAmount)
    )
      continue;
    const endpoints = new Set([
      source.accountAddress,
      destination.accountAddress,
    ]);
    if (
      movements.filter(
        (m) => endpoints.has(m.fromAccount) || endpoints.has(m.toAccount),
      ).length !== 2
    )
      continue;
    const positions = [incoming, outgoing].map((m) =>
      tx.instructions.findIndex(
        (i) => i.outerIndex === m.outerIndex && i.innerIndex === m.innerIndex,
      ),
    );
    if (positions.some((p) => p < 0)) continue;
    const initializations = tx.instructions
      .map((i, index) => ({ i, index }))
      .filter(
        ({ i }) =>
          i.programId === SOLANA_TOKEN_2022_PROGRAM &&
          [
            "initializeAccount",
            "initializeAccount2",
            "initializeAccount3",
          ].includes(i.type ?? "") &&
          i.info?.account === temporaryAddress,
      );
    const closures = tx.instructions
      .map((i, index) => ({ i, index }))
      .filter(
        ({ i }) =>
          i.programId === SOLANA_TOKEN_2022_PROGRAM &&
          i.type === "closeAccount" &&
          i.info?.account === temporaryAddress,
      );
    if (
      initializations.length !== 1 ||
      closures.length !== 1 ||
      initializations[0].i.info?.owner !== temporary.preOwner ||
      initializations[0].i.info?.mint !== temporary.mint ||
      initializations[0].index >= positions[0] ||
      closures[0].index <= positions[1]
    )
      continue;
    const involved = new Set([...endpoints, temporaryAddress]);
    let safe = true;
    for (const [index, instruction] of tx.instructions.entries()) {
      if (positions.includes(index)) {
        const next = tx.instructions[index + 1];
        if (
          instruction.programId !== SOLANA_TOKEN_2022_PROGRAM ||
          !["transfer", "transferChecked"].includes(instruction.type ?? "") ||
          instruction.stackHeight === null ||
          (next?.outerIndex === instruction.outerIndex &&
            next.innerIndex !== null &&
            (next.stackHeight === null ||
              next.stackHeight > instruction.stackHeight))
        )
          safe = false;
      } else if (
        instruction.programId === SOLANA_TOKEN_2022_PROGRAM &&
        (instruction.accountAddresses?.some((a) => involved.has(a)) ||
          Object.values(instruction.info ?? {}).some(
            (v) => typeof v === "string" && involved.has(v),
          )) &&
        ![
          "getAccountDataSize",
          "initializeImmutableOwner",
          "initializeAccount",
          "initializeAccount2",
          "initializeAccount3",
          "closeAccount",
        ].includes(instruction.type ?? "")
      )
        safe = false;
    }
    if (safe) return true;
  }
  return false;
}

/** Isolated endpoint balance proof, not a reconstruction of historical extensions. */
export function token2022QuantityEvidence(
  tx: NormalizedSolanaTransaction,
  movement: SolanaRawMovement,
  movements: readonly SolanaRawMovement[],
  accounts: ReadonlyMap<string, SolanaTokenAccountBalance>,
): NonNullable<SolanaRawMovement["quantityEvidence"]> {
  const result: NonNullable<SolanaRawMovement["quantityEvidence"]> = {
    state: "unavailable",
    programId: SOLANA_TOKEN_2022_PROGRAM,
    grossRaw: movement.rawAmount,
    debitRaw: null,
    creditRaw: null,
    unexplainedDifferenceRaw: null,
  };
  const source = accounts.get(movement.fromAccount);
  const destination = accounts.get(movement.toAccount);
  if (
    tx.succeeded === true &&
    linearTemporaryProof(tx, movement, movements, accounts)
  ) {
    return {
      ...result,
      state: "exact",
      debitRaw: movement.rawAmount,
      creditRaw: movement.rawAmount,
      unexplainedDifferenceRaw: "0",
    };
  }
  if (
    !source ||
    !destination ||
    source.accountAddress === destination.accountAddress ||
    source.preRaw === null ||
    source.postRaw === null ||
    destination.preRaw === null ||
    destination.postRaw === null ||
    !source.preOwner ||
    !destination.preOwner ||
    source.preOwner !== source.postOwner ||
    destination.preOwner !== destination.postOwner
  )
    return result;
  // Endpoints with several operations do not permit attributing whole-transaction
  // balance deltas to any single transfer, even when the final totals match.
  if (
    movements.filter((m) =>
      [m.fromAccount, m.toAccount].some(
        (a) => a === source.accountAddress || a === destination.accountAddress,
      ),
    ).length !== 1
  )
    return result;
  const instructionIndex = tx.instructions.findIndex(
    (i) =>
      i.outerIndex === movement.outerIndex &&
      i.innerIndex === movement.innerIndex,
  );
  const instruction = tx.instructions[instructionIndex];
  if (!instruction || instruction.programId !== SOLANA_TOKEN_2022_PROGRAM)
    return result;
  const debit = BigInt(source.preRaw) - BigInt(source.postRaw);
  const credit = BigInt(destination.postRaw) - BigInt(destination.preRaw);
  if (debit < BigInt(0) || credit < BigInt(0)) return result;
  result.debitRaw = String(debit);
  result.creditRaw = String(credit);
  result.unexplainedDifferenceRaw = String(debit - credit);
  result.state = "delta_only";
  const next = tx.instructions[instructionIndex + 1];
  const nested =
    next?.outerIndex === instruction.outerIndex &&
    next.innerIndex !== null &&
    (instruction.innerIndex === null ||
      instruction.stackHeight === null ||
      next.stackHeight === null ||
      next.stackHeight > instruction.stackHeight);
  const endpoint = new Set([source.accountAddress, destination.accountAddress]);
  const otherAuthorityEffect = tx.instructions.some(
    (i) =>
      i !== instruction &&
      i.programId === SOLANA_TOKEN_2022_PROGRAM &&
      ![
        "getAccountDataSize",
        "initializeImmutableOwner",
        "initializeAccount",
        "initializeAccount2",
        "initializeAccount3",
        "closeAccount",
      ].includes(i.type ?? "") &&
      (i.accountAddresses?.some((a) => endpoint.has(a)) ||
        Object.values(i.info ?? {}).some(
          (v) => typeof v === "string" && endpoint.has(v),
        )),
  );
  if (
    !nested &&
    !otherAuthorityEffect &&
    debit === BigInt(movement.rawAmount) &&
    credit === debit
  )
    result.state = "exact";
  return result;
}
