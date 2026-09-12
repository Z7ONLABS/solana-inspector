import { SOLANA_USDC_MINT } from "../../src/analytics/solana/route-constants";
import { SOLANA_TOKEN_PROGRAM } from "../../src/analytics/solana/normalize";
import type { SolanaProvenance } from "../../src/analytics/solana/types";

export const SOLANA_TEST_WALLET = "fixture-wallet";
export const SOLANA_TEST_TOKEN = "fixture-token-mint";
export const SOLANA_TEST_VAULT = "fixture-fee-ata";
export const SOLANA_TEST_ROUTER = "fixture-grouped-router";
export const SOLANA_TEST_PROVENANCE: SolanaProvenance = {
  source: "deterministic-test-fixture",
  payloadSha256: "a".repeat(64),
  commitment: "finalized",
  commitmentEvidence: "request",
};
export const SOLANA_TEST_CONTEXT = {
  walletAddress: SOLANA_TEST_WALLET,
  feeOwner: "fixture-fee-owner",
  feeTokenAccounts: new Set([SOLANA_TEST_VAULT]),
  transactionOrder: 1,
};

export function solanaTokenTransfer(
  source: string,
  destination: string,
  amount: string,
) {
  return {
    programId: SOLANA_TOKEN_PROGRAM,
    program: "spl-token",
    parsed: { type: "transfer", info: { source, destination, amount } },
  };
}

/** Deterministic synthetic economics; never application or provider data. */
export function solanaSwapFixture(
  options: {
    sell?: boolean;
    sponsor?: boolean;
    signature?: string;
    slot?: number;
  } = {},
) {
  const sell = options.sell ?? false;
  const keys = [
    SOLANA_TEST_WALLET,
    "user-usdc",
    "user-token",
    "pool-usdc",
    "pool-token",
    SOLANA_TEST_VAULT,
    SOLANA_TEST_ROUTER,
    SOLANA_TOKEN_PROGRAM,
  ];
  const balances = [
    {
      index: 1,
      mint: SOLANA_USDC_MINT,
      owner: SOLANA_TEST_WALLET,
      before: "10000000",
      after: sell ? "19900000" : "4900000",
    },
    {
      index: 2,
      mint: SOLANA_TEST_TOKEN,
      owner: SOLANA_TEST_WALLET,
      before: sell ? "2500000" : "0",
      after: sell ? "0" : "2500000",
    },
    {
      index: 3,
      mint: SOLANA_USDC_MINT,
      owner: "fixture-pool",
      before: "100000000",
      after: sell ? "90000000" : "105000000",
    },
    {
      index: 4,
      mint: SOLANA_TEST_TOKEN,
      owner: "fixture-pool",
      before: "100000000",
      after: sell ? "102500000" : "97500000",
    },
    {
      index: 5,
      mint: SOLANA_USDC_MINT,
      owner: "fixture-fee-owner",
      before: "1000",
      after: "101000",
    },
  ];
  const preBalances: number[] = keys.map((_, index) =>
    index === 0 ? 1_000_000_000 : 2_000_000,
  );
  const postBalances = [...preBalances];
  postBalances[0] -= options.sponsor ? 0 : 5_000;
  if (options.sponsor) {
    keys.unshift("fixture-network-sponsor");
    preBalances.unshift(1_000_000);
    postBalances.unshift(995_000);
  }
  const offset = options.sponsor ? 1 : 0;
  const tokenBalances = (side: "before" | "after") =>
    balances.map((balance) => ({
      accountIndex: balance.index + offset,
      mint: balance.mint,
      owner: balance.owner,
      uiTokenAmount: { amount: balance[side], decimals: 6 },
    }));
  return {
    version: "legacy",
    slot: options.slot ?? (sell ? 43 : 42),
    transactionIndex: 0,
    blockTime: 1_700_000_000 + (sell ? 60 : 0),
    transaction: {
      signatures: [
        options.signature ?? (sell ? "fixture-sell" : "fixture-buy"),
      ],
      message: {
        accountKeys: keys.map((pubkey, index) => ({
          pubkey,
          signer: index === 0 || pubkey === SOLANA_TEST_WALLET,
        })),
        instructions: [
          {
            programId: SOLANA_TEST_ROUTER,
            accounts: [SOLANA_TEST_WALLET],
            data: "opaque-grouped-swap",
          },
          solanaTokenTransfer("user-usdc", SOLANA_TEST_VAULT, "100000"),
        ] as unknown[],
      },
    },
    meta: {
      err: null as unknown,
      fee: 5_000,
      preBalances,
      postBalances,
      preTokenBalances: tokenBalances("before"),
      postTokenBalances: tokenBalances("after"),
      innerInstructions: [
        {
          index: 0,
          instructions: sell
            ? [
                solanaTokenTransfer("user-token", "pool-token", "2500000"),
                solanaTokenTransfer("pool-usdc", "user-usdc", "10000000"),
              ]
            : [
                solanaTokenTransfer("user-usdc", "pool-usdc", "5000000"),
                solanaTokenTransfer("pool-token", "user-token", "2500000"),
              ],
        },
      ],
    },
  };
}
