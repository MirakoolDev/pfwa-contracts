"use client";
// Take liquidity back out: close (or shrink) your positions in this market's pools, then turn the full sets you
// get back into USDG. Works at any stage, trading or not; after the outcome is final, redeem the winner instead.
import { useState } from "react";
import { erc20Abi, type PublicClient } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { TARGET_CHAIN_ID } from "@/lib/config";
import { MULTICALL3, POSITION_MANAGER } from "@/lib/orderbook/config";
import { obMarketAbi } from "@/lib/orderbook/abi";
import { positionManagerAbi, withdrawUnlockData, type LpPosition } from "@/lib/orderbook/liquidity";
import { fmtAmount } from "@/lib/orderbook/math";
import type { BookMarket } from "@/lib/orderbook/read";
import { useLpPositions } from "@/hooks/useBook";
import { ActionButton, Panel, Seg } from "./ui";
import { useTxFlow, type FlowStep } from "./useTxFlow";

const SHARES = ["25", "50", "100"] as const;
type Share = (typeof SHARES)[number];

export default function WithdrawPanel({ market, onDone }: { market: BookMarket; onDone: () => void }) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as unknown as PublicClient;
  const { writeContractAsync } = useWriteContract();
  const { data: positions, refetch } = useLpPositions(market, address);
  const { start, modal, running } = useTxFlow(() => {
    onDone();
    void refetch();
  });
  const [share, setShare] = useState<Share>("100");

  if (!address || !positions || positions.length === 0) return modal;
  const pct = Number(share);
  const part = (x: bigint) => (x * BigInt(pct)) / BigInt(100);
  const usdg = positions.reduce((s, p) => s + part(p.usdg), BigInt(0));

  const holdings = async () =>
    (await client.multicall({
      multicallAddress: MULTICALL3,
      allowFailure: false,
      contracts: market.outcomes.map((o) => ({ address: o.token, abi: erc20Abi, functionName: "balanceOf", args: [address] }) as const),
    })) as bigint[];

  const submit = () => {
    const snapshot: LpPosition[] = positions;
    // Only the full sets that came out of the pools go back to USDG, never outcome tokens you already held.
    let before: bigint[] | null = null;
    const setsFromPools = async () => {
      if (!before) return BigInt(0);
      const after = await holdings();
      const gained = after.map((a, i) => (a > before![i] ? a - before![i] : BigInt(0)));
      return gained.reduce((a, b) => (b < a ? b : a), gained[0] ?? BigInt(0));
    };
    const steps: FlowStep[] = [
      {
        id: "withdraw",
        label: pct === 100 ? `Close ${snapshot.length} position${snapshot.length === 1 ? "" : "s"}` : `Take ${pct}% out of ${snapshot.length} position${snapshot.length === 1 ? "" : "s"}`,
        // On "Try again" after the second step failed, the positions are already out.
        skip: async () => {
          const left = await client
            .readContract({ address: POSITION_MANAGER, abi: positionManagerAbi, functionName: "getPositionLiquidity", args: [snapshot[0].tokenId] })
            .catch(() => BigInt(0));
          return before && left < snapshot[0].liquidity ? "Already withdrawn" : false;
        },
        run: async () => {
          before = await holdings();
          return writeContractAsync({
            address: POSITION_MANAGER,
            abi: positionManagerAbi,
            functionName: "modifyLiquidities",
            args: [withdrawUnlockData(snapshot, pct, address), BigInt(Math.floor(Date.now() / 1000) + 1200)],
            chainId: TARGET_CHAIN_ID,
          });
        },
      },
      {
        id: "burn",
        label: "Turn full sets back into USDG",
        skip: async () => {
          if (market.resolved) return "The outcome is final: redeem the winning tokens instead";
          return (await setsFromPools()) === BigInt(0) ? "No full sets came out of the pools" : false;
        },
        run: async () => {
          const sets = await setsFromPools();
          return writeContractAsync({ address: market.market, abi: obMarketAbi, functionName: "burnSet", args: [sets, address], chainId: TARGET_CHAIN_ID });
        },
      },
    ];
    void start("Withdraw liquidity", steps);
  };

  return (
    <Panel title="Your liquidity" collapsible>
      {modal}
      <div className="space-y-3">
        <ul className="font-mono text-[11px] space-y-1.5">
          {positions.map((p) => (
            <li key={p.tokenId.toString()} className="flex justify-between gap-3">
              <span className="text-neutral-500">{p.outcome.name} pool · #{p.tokenId.toString()}</span>
              <span className="tabular-nums text-right text-neutral-700 dark:text-neutral-300">
                {fmtAmount(p.tokens)} {p.outcome.name} + {fmtAmount(p.usdg)} USDG
              </span>
            </li>
          ))}
        </ul>
        <Seg value={share} onChange={setShare} options={SHARES.map((s) => ({ value: s, label: s === "100" ? "All" : `${s}%` }))} />
        <div className="font-mono text-[11px] text-neutral-500 space-y-1">
          <div className="flex justify-between gap-3">
            <span>USDG from the pools</span>
            <span className="tabular-nums text-black dark:text-white font-bold">≈ {fmtAmount(usdg)} USDG</span>
          </div>
          {positions
            .filter((p, i, all) => all.findIndex((q) => q.outcome.index === p.outcome.index) === i)
            .map((p) => {
              const tokens = positions.filter((q) => q.outcome.index === p.outcome.index).reduce((s, q) => s + part(q.tokens), BigInt(0));
              return (
                <div key={p.outcome.token} className="flex justify-between gap-3">
                  <span>{p.outcome.name} back</span>
                  <span className="tabular-nums text-neutral-700 dark:text-neutral-300">≈ {fmtAmount(tokens)}</span>
                </div>
              );
            })}
          <p className="leading-relaxed pt-1">
            {market.resolved
              ? "The outcome is final, so after this redeem your winning tokens for USDG."
              : "Then the full sets (one of each outcome) that come out of the pools turn back into 1 USDG each. Leftover tokens of one outcome stay in your wallet to sell or hold."}
          </p>
        </div>
        <ActionButton onClick={submit} disabled={running}>
          {pct === 100 ? "Withdraw all" : `Withdraw ${pct}%`}
        </ActionButton>
      </div>
    </Panel>
  );
}
