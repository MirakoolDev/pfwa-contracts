"use client";
// Order book market data for the /book pages, read live from the chain.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { createPublicClient, http, erc20Abi, type Address, type ContractFunctionParameters, type PublicClient } from "viem";
import { OB, OB_ENABLED, OB_LOGS_RPC, MULTICALL3, USDG } from "@/lib/orderbook/config";
import { obHookAbi, obLockerAbi, obResolverAbi } from "@/lib/orderbook/abi";
import { listedBookMarkets } from "@/lib/orderbook/listing";
import { loadBookMarkets, type BookMarket, type BookOutcome } from "@/lib/orderbook/read";
import { loadMyOrders, loadOrderBook } from "@/lib/orderbook/orders";
import { MIN_LOCKED_RAW, loadPositions } from "@/lib/orderbook/liquidity";
import { loadPriceHistory, loadHolders } from "@/lib/orderbook/history";
import { TARGET_CHAIN_ID, robinhoodChain } from "@/lib/config";

function useClient() {
  return usePublicClient({ chainId: TARGET_CHAIN_ID }) as unknown as PublicClient | undefined;
}

// Event scans (limit orders, positions) go through OB_LOGS_RPC: see lib/orderbook/config.ts.
const logsClient = createPublicClient({ chain: robinhoodChain, transport: http(OB_LOGS_RPC) }) as unknown as PublicClient;

/** Refetches every order book query, e.g. after a transaction. */
export function useRefreshBook() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["book"] });
}

export function useBookMarkets() {
  const client = useClient();
  return useQuery({
    queryKey: ["book", "markets"],
    enabled: OB_ENABLED && !!client,
    refetchInterval: 30_000,
    staleTime: 10_000,
    queryFn: async () => {
      return listedBookMarkets(client!);
    },
  });
}

export function useBookMarket(id: number | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: ["book", "market", id],
    enabled: OB_ENABLED && !!client && id !== undefined && Number.isFinite(id),
    refetchInterval: 15_000,
    staleTime: 5_000,
    queryFn: async () => (await loadBookMarkets(client!, [id!]))[0] ?? null,
  });
}

export type BookUser = {
  usdg: bigint;
  balances: bigint[];
  mayResolve: boolean;
  isArbiter: boolean;
  creatorFees: bigint;
};

export function useBookUser(m: BookMarket | null | undefined, owner: Address | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: ["book", "user", m?.id, owner],
    enabled: OB_ENABLED && !!client && !!m && !!owner,
    refetchInterval: 15_000,
    staleTime: 5_000,
    queryFn: async (): Promise<BookUser> => {
      const hook = m!.outcomes[0].key.hooks;
      const contracts: ContractFunctionParameters[] = [
        { address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [owner!] },
        { address: OB.resolver!, abi: obResolverAbi, functionName: "mayResolve", args: [BigInt(m!.id), owner!] },
        { address: OB.resolver!, abi: obResolverAbi, functionName: "arbiter" },
        { address: hook, abi: obHookAbi, functionName: "creatorFeesOwed", args: [owner!] },
        ...m!.outcomes.map((o) => ({ address: o.token, abi: erc20Abi, functionName: "balanceOf", args: [owner!] })),
      ];
      const r = (await client!.multicall({ multicallAddress: MULTICALL3, allowFailure: false, contracts })) as unknown[];
      return {
        usdg: r[0] as bigint,
        mayResolve: r[1] as boolean,
        isArbiter: (r[2] as Address).toLowerCase() === owner!.toLowerCase(),
        creatorFees: r[3] as bigint,
        balances: r.slice(4) as bigint[],
      };
    },
  });
}

export function useOrderBook(outcome: BookOutcome | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: ["book", "levels", outcome?.poolId],
    enabled: OB_ENABLED && !!client && !!outcome,
    refetchInterval: 20_000,
    staleTime: 5_000,
    queryFn: () => loadOrderBook(logsClient, outcome!),
  });
}

export function useMyOrders(m: BookMarket | null | undefined, owner: Address | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: ["book", "orders", m?.id, owner],
    enabled: OB_ENABLED && !!client && !!m && !!owner,
    refetchInterval: 20_000,
    staleTime: 5_000,
    queryFn: () => loadMyOrders(logsClient, owner!, m!),
  });
}

/** The liquidity positions `owner` holds in this market's pools. */
export function useLpPositions(m: BookMarket | null | undefined, owner: Address | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: ["book", "positions", m?.id, owner],
    enabled: OB_ENABLED && !!client && !!m && !!owner,
    refetchInterval: 20_000,
    staleTime: 5_000,
    queryFn: () => loadPositions(logsClient, m!, owner!),
  });
}


/** The market's price history from its pools' swaps, one point per swap (lib/orderbook/history). */
export function usePriceHistory(m: BookMarket | null | undefined) {
  return useQuery({
    queryKey: ["book", "history", m?.id, m?.outcomes.map((o) => o.price).join(",")],
    enabled: OB_ENABLED && !!m,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
    queryFn: () => loadPriceHistory(logsClient, m!),
  });
}

/** Who holds each outcome of a market (from the tokens' Transfer events). */
export function useHolders(m: BookMarket | null | undefined) {
  return useQuery({
    queryKey: ["book", "holders", m?.id, m?.collateral.toString()],
    enabled: OB_ENABLED && !!m,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: () => loadHolders(logsClient, m!, [OB.limitOrders, OB.locker, OB.forwarder].filter(Boolean) as string[]),
  });
}
