"use client";
// The creator's liquidity, held by the LiquidityLocker while the market trades: how much is locked, a way for the
// creator to add it if the create flow didn't finish, and Release once trading has stopped.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { PublicClient } from "viem";
import { TARGET_CHAIN_ID } from "@/lib/config";
import { MULTICALL3, OB } from "@/lib/orderbook/config";
import { obLockerAbi } from "@/lib/orderbook/abi";
import { MIN_CREATOR_LIQUIDITY_USDG, MIN_LOCKED_RAW } from "@/lib/orderbook/liquidity";
import { fmtAmount } from "@/lib/orderbook/math";
import type { BookMarket } from "@/lib/orderbook/read";
import type { BookUser } from "@/hooks/useBook";
import { ActionButton, AmountInput, Panel, parseAmount } from "./ui";
import { useTxFlow } from "./useTxFlow";
import { lockedSeedSteps } from "./lockerSteps";

const MIN = BigInt(MIN_CREATOR_LIQUIDITY_USDG) * BigInt(1_000_000);

/** What the locker holds for a market: all of it, the creator's part, and the viewer's positions. */
export function useLocked(market: BookMarket | undefined, viewer: `0x${string}` | undefined) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as unknown as PublicClient;
  return useQuery({
    queryKey: ["book", "locked", market?.id, viewer],
    enabled: !!OB.locker && !!market && !!client,
    refetchInterval: 15_000,
    queryFn: async () => {
      const id = BigInt(market!.id);
      const [total, creator, mine] = await client.multicall({
        multicallAddress: MULTICALL3,
        allowFailure: false,
        contracts: [
          { address: OB.locker!, abi: obLockerAbi, functionName: "totalLockedUsdg", args: [id] },
          { address: OB.locker!, abi: obLockerAbi, functionName: "lockedUsdg", args: [id, market!.creator] },
          { address: OB.locker!, abi: obLockerAbi, functionName: "lockedPositions", args: [id, viewer ?? market!.creator] },
        ],
      });
      return { total: total as bigint, creator: creator as bigint, mine: viewer ? (mine as readonly bigint[]).length : 0 };
    },
  });
}

export default function LockedLiquidityPanel({ market, user, onDone, highlight }: { market: BookMarket; user: BookUser | undefined; onDone: () => void; highlight?: boolean }) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as unknown as PublicClient;
  const { writeContractAsync } = useWriteContract();
  const locked = useLocked(market, address);
  const refresh = () => { void locked.refetch(); onDone(); };
  const { start, modal, running } = useTxFlow(refresh);
  const [amount, setAmount] = useState(String(MIN_CREATOR_LIQUIDITY_USDG));
  if (!OB.locker) return null;

  const l = locked.data;
  const isCreator = !!address && address.toLowerCase() === market.creator.toLowerCase();
  const short = !!l && l.creator < MIN_LOCKED_RAW;
  const raw = parseAmount(amount);

  const seed = () => {
    if (!address) return;
    void start("Add your liquidity", lockedSeedSteps({ client, write: writeContractAsync, owner: address, marketId: () => market.id, usdg: raw }));
  };
  const release = () => {
    if (!address) return;
    void start("Take back your liquidity", [{
      id: "release",
      label: "Release your positions",
      run: () => writeContractAsync({ address: OB.locker!, abi: obLockerAbi, functionName: "release", args: [BigInt(market.id), address], chainId: TARGET_CHAIN_ID }),
    }]);
  };

  return (
    <Panel title="Creator liquidity" collapsible open={highlight || (isCreator && short) || (isCreator && !market.tradingOpen)} right={l ? <span className="font-mono text-[10px] text-neutral-500 tabular-nums">{fmtAmount(l.total)} USDG locked</span> : undefined}>
      {modal}
      <div className="space-y-3">
        {!l ? (
          <p className="font-mono text-[11px] text-neutral-500">Reading…</p>
        ) : (
          <p className="font-mono text-[11px] text-neutral-500 leading-relaxed">
            <span className="font-bold text-black dark:text-white">{fmtAmount(l.total)} USDG</span>{" "}of liquidity is locked in this market&apos;s pools
            {market.tradingOpen ? " until trading stops" : ""}. Nobody can take it out while the market trades, the creator included.
          </p>
        )}

        {market.tradingOpen && isCreator && short && (
          <>
            {highlight && (
              <p className="border border-[#00ff87]/40 bg-[#00ff87]/10 p-3 font-mono text-[11px] text-black dark:text-white leading-relaxed">
                Your market is created. Add your liquidity (at least {MIN_CREATOR_LIQUIDITY_USDG} USDG) to open it for trading.
              </p>
            )}
            <AmountInput label="Your liquidity" value={amount} onChange={setAmount} unit="USDG" balance={user ? fmtAmount(user.usdg) : undefined} />
            <ActionButton onClick={seed} disabled={running || raw + (l?.creator ?? BigInt(0)) < MIN || (!!user && raw > user.usdg)}>
              Add and lock liquidity
            </ActionButton>
          </>
        )}
        {market.tradingOpen && short && !isCreator && (
          <p className="font-mono text-[11px] text-amber-600 dark:text-amber-400">The creator hasn&apos;t added their {MIN_CREATOR_LIQUIDITY_USDG} USDG of liquidity yet.</p>
        )}

        {!market.tradingOpen && !!l && l.mine > 0 && (
          <>
            <p className="font-mono text-[11px] text-neutral-500">Trading has stopped, so your {l.mine} position{l.mine === 1 ? "" : "s"} can come back to your wallet. Then withdraw them under Your liquidity, and redeem the winning tokens once the outcome is final.</p>
            <ActionButton onClick={release} disabled={running}>Release my liquidity</ActionButton>
          </>
        )}
      </div>
    </Panel>
  );
}
