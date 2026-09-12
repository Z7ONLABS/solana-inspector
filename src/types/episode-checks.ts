/** Pure diagnostic types shared by the offline ledger and public report. */
export type WalletEpisodeCheck = {
  state: "proven" | "unavailable";
  reasons: string[];
};
export type WalletEpisodeChecks = {
  version: "solana-episode-checks-v1";
  buys: number;
  sells: number;
  transactionIds: string[];
  gates: {
    trades: WalletEpisodeCheck;
    quantities: WalletEpisodeCheck;
    fees: WalletEpisodeCheck;
    inventory: WalletEpisodeCheck;
    valuation: WalletEpisodeCheck;
    financialResult: WalletEpisodeCheck;
  };
};
