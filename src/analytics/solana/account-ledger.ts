import { spotAssetKey, type SpotAssetRef } from "../spot";
import type {
  SolanaEconomicTransaction,
  SolanaWalletBalanceEvidence,
} from "./types";

export type SolanaAccountInventory = {
  address: string;
  asset: SpotAssetRef;
  programId: string | null;
  generation: number;
  ownershipInterval: number;
  owner: string | null;
  rawAmount: string | null;
  decimals: number;
  closed: boolean;
  ended: boolean;
  lastObservedAt: string | null;
  slot: number | null;
  signature: string | null;
  evidence: "per_account" | "legacy_single_account";
};

type Observation = NonNullable<
  SolanaWalletBalanceEvidence["accountObservations"]
>[number] & {
  programId?: string | null;
  preOwner?: string | null;
  postOwner?: string | null;
};

function amount(value: string | null): bigint | null {
  return value !== null && /^\d+$/.test(value) ? BigInt(value) : null;
}

/** Tracks only evidenced account intervals. An account list is never a wallet-universe proof. */
export class SolanaAccountLedger {
  private readonly current = new Map<string, SolanaAccountInventory>();
  private readonly retired: SolanaAccountInventory[] = [];
  private readonly opaqueAssets = new Set<string>();

  constructor(private readonly wallet: string) {}

  private total(key: string): bigint | null {
    if (this.opaqueAssets.has(key)) return null;
    let sum = BigInt(0);
    for (const account of this.current.values()) {
      if (spotAssetKey(account.asset) !== key || account.closed) continue;
      if (account.owner === null) return null;
      if (account.owner !== this.wallet) continue;
      const value = amount(account.rawAmount);
      if (value === null) return null;
      sum += value;
    }
    return sum;
  }

  observe(
    evidence: SolanaWalletBalanceEvidence,
    tx: SolanaEconomicTransaction,
    chronologyProven = true,
  ) {
    const key = spotAssetKey(evidence.asset);
    const reasons = new Set<string>();
    let observations: Observation[];
    let mode: SolanaAccountInventory["evidence"] = "per_account";
    if (evidence.accountObservations?.length) {
      observations = evidence.accountObservations;
      const addresses = new Set(observations.map((item) => item.address));
      if (
        addresses.size !== observations.length ||
        addresses.size !== evidence.accountAddresses.length ||
        evidence.accountAddresses.some((address) => !addresses.has(address))
      ) {
        reasons.add("account_observation_set_mismatch");
        this.opaqueAssets.add(key);
        return { pre: null, post: null, reasons, accounts: this.forAsset(key) };
      }
    } else if (evidence.accountAddresses.length === 1) {
      // Old records retain their old single-account evidence, without acquiring
      // new ownership or lifecycle guarantees from reinterpretation.
      mode = "legacy_single_account";
      observations = [
        {
          address: evidence.accountAddresses[0],
          preRaw: evidence.preRaw,
          postRaw: evidence.postRaw,
          created: false,
          closed: false,
        },
      ];
    } else {
      reasons.add("per_account_balance_evidence_unavailable");
      this.opaqueAssets.add(key);
      return { pre: null, post: null, reasons, accounts: this.forAsset(key) };
    }

    // First materialize every touched pre-state, then take the owner's total.
    // Untouched accounts stay in the registry; their absence is not a zero.
    for (const observation of observations) {
      const previous = this.current.get(observation.address);
      const hasOwners = "preOwner" in observation || "postOwner" in observation;
      const preOwner = hasOwners ? (observation.preOwner ?? null) : this.wallet;
      const programId = observation.programId ?? previous?.programId ?? null;
      if (observation.mint && observation.mint !== evidence.asset.assetId)
        reasons.add("account_asset_identity_mismatch");
      const identityChanged =
        previous &&
        (spotAssetKey(previous.asset) !== key ||
          (previous.programId !== null &&
            programId !== null &&
            previous.programId !== programId));
      const newGeneration = !!previous?.closed && observation.created;
      if (
        (identityChanged && !newGeneration) ||
        (previous?.closed && !observation.created)
      ) {
        reasons.add("account_generation_unproven");
        this.opaqueAssets.add(key);
      }
      if (previous && !newGeneration) {
        if (previous.decimals !== evidence.decimals)
          reasons.add("asset_decimals_changed");
        if (previous.owner !== preOwner)
          reasons.add("account_ownership_discontinuity");
        if (
          amount(previous.rawAmount) !== null &&
          amount(observation.preRaw) !== null &&
          amount(previous.rawAmount) !== amount(observation.preRaw)
        )
          reasons.add("account_balance_discontinuity");
        if (observation.created && !previous.closed)
          reasons.add("account_generation_unproven");
      }
      if (previous && newGeneration)
        this.retired.push({ ...previous, ended: true });
      if (observation.created && amount(observation.preRaw) !== BigInt(0))
        reasons.add("created_account_zero_unproven");
      if (amount(observation.preRaw) === null)
        reasons.add("account_pre_balance_unknown");
      if (
        preOwner === null &&
        !(observation.created && amount(observation.preRaw) === BigInt(0))
      )
        reasons.add("account_pre_owner_unknown");
      this.current.set(observation.address, {
        address: observation.address,
        asset: evidence.asset,
        programId,
        generation: previous ? previous.generation + Number(newGeneration) : 0,
        ownershipInterval: newGeneration
          ? 0
          : (previous?.ownershipInterval ?? 0),
        owner: preOwner,
        rawAmount: observation.preRaw,
        decimals: evidence.decimals,
        // A newly created account did not belong to the pre-state universe.
        closed: observation.created && amount(observation.preRaw) === BigInt(0),
        ended: false,
        lastObservedAt: tx.executedAt,
        slot: tx.slot,
        signature: tx.signature,
        evidence: mode,
      });
    }
    const pre = this.total(key);
    let touchedPre = BigInt(0);
    let touchedPost = BigInt(0);
    let touchedKnown = true;
    for (const observation of observations) {
      const state = this.current.get(observation.address)!;
      const hasOwners = "preOwner" in observation || "postOwner" in observation;
      const postOwner = hasOwners
        ? (observation.postOwner ?? null)
        : this.wallet;
      const preAmount = amount(observation.preRaw);
      const postAmount = amount(observation.postRaw);
      if (preAmount === null || postAmount === null) touchedKnown = false;
      else {
        if (state.owner === this.wallet) touchedPre += preAmount;
        if (postOwner === this.wallet && !observation.closed)
          touchedPost += postAmount;
      }
      if (postAmount === null) reasons.add("account_post_balance_unknown");
      if (postOwner === null && !observation.closed)
        reasons.add("account_post_owner_unknown");
      if (observation.closed && postAmount !== BigInt(0))
        reasons.add("closed_account_zero_unproven");
      if (
        evidence.asset.assetId !== "native" &&
        preAmount !== null &&
        postAmount !== null
      ) {
        let movementDelta = BigInt(0);
        for (const movement of tx.rawMovements) {
          if (spotAssetKey(movement.asset) !== key) continue;
          const quantity = movement.quantityEvidence;
          const debit = amount(
            quantity?.state === "exact"
              ? quantity.debitRaw
              : movement.rawAmount,
          );
          const credit = amount(
            quantity?.state === "exact"
              ? quantity.creditRaw
              : movement.rawAmount,
          );
          if (debit === null || credit === null) {
            reasons.add("invalid_raw_movement");
            continue;
          }
          if (movement.fromAccount === observation.address)
            movementDelta -= debit;
          if (movement.toAccount === observation.address)
            movementDelta += credit;
        }
        if (movementDelta !== postAmount - preAmount)
          reasons.add("account_movement_balance_residual");
      }
      if (
        state.owner !== postOwner &&
        !observation.created &&
        !observation.closed
      ) {
        this.retired.push({ ...state, ended: true });
        state.ownershipInterval += 1;
        reasons.add("account_custody_change");
      }
      state.owner = postOwner;
      state.rawAmount = observation.postRaw;
      state.closed = observation.closed && postAmount === BigInt(0);
      if (!chronologyProven) {
        // The archive still preserves each observation; the current interval
        // cannot select a latest balance using signature or input-array order.
        state.rawAmount = null;
        state.closed = false;
        reasons.add("account_observation_order_unproven");
      }
    }
    if (
      evidence.complete &&
      touchedKnown &&
      (amount(evidence.preRaw) !== touchedPre ||
        amount(evidence.postRaw) !== touchedPost)
    )
      reasons.add("account_aggregate_balance_mismatch");
    return {
      pre,
      post: this.total(key),
      reasons,
      accounts: this.forAsset(key),
    };
  }

  forAsset(key: string) {
    return [...this.current.values()].filter(
      (item) => spotAssetKey(item.asset) === key,
    );
  }

  snapshot(): SolanaAccountInventory[] {
    return [...this.retired, ...this.current.values()]
      .map((item) => ({ ...item }))
      .sort(
        (a, b) =>
          a.address.localeCompare(b.address) ||
          a.generation - b.generation ||
          a.ownershipInterval - b.ownershipInterval,
      );
  }
}
