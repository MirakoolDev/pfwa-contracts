// The steps that add a creator's liquidity through the LiquidityLocker: approve the USDG, then one call that mints the
// sets, opens a position in every outcome pool around its current price (± CREATOR_BAND) and locks them until trading
// stops. Used by both create pages (right after the market is created) and the market page (to finish seeding).
import type { PublicClient } from "viem";
import { TARGET_CHAIN_ID } from "@/lib/config";
import { OB, USDG } from "@/lib/orderbook/config";
import { obLockerAbi } from "@/lib/orderbook/abi";
import { CREATOR_BAND, seedPlan } from "@/lib/orderbook/liquidity";
import { fmtAmount } from "@/lib/orderbook/math";
import { loadBookMarkets } from "@/lib/orderbook/read";
import { approveStep, type FlowStep } from "./useTxFlow";

type Write = Parameters<typeof approveStep>[1];

export function lockedSeedSteps(p: {
  client: PublicClient;
  write: Write;
  owner: `0x${string}`;
  /** The market's id; for a market created in the same flow, known once its create step has a receipt. */
  marketId: () => number | undefined;
  usdg: bigint;
}): FlowStep[] {
  const amount = fmtAmount(p.usdg);
  return [
    approveStep(p.client, p.write, { token: USDG, owner: p.owner, spender: OB.locker!, amount: p.usdg, label: `Approve ${amount} USDG of liquidity` }),
    {
      id: "seed-locked",
      label: `Add ${amount} USDG of liquidity, locked while the market trades`,
      run: async () => {
        const id = p.marketId();
        if (id === undefined) throw new Error("The market isn't created yet.");
        const [market] = await loadBookMarkets(p.client, [id]);
        const plan = market && seedPlan(market, p.usdg, CREATOR_BAND);
        if (!plan) throw new Error("Couldn't work out the liquidity at the current prices.");
        const positions = plan.positions.map((x) => ({
          outcome: x.outcome.index,
          tickLower: x.tickLower,
          tickUpper: x.tickUpper,
          liquidity: x.liquidity,
          amount0Max: x.amount0Max,
          amount1Max: x.amount1Max,
        }));
        return p.write({
          address: OB.locker!,
          abi: obLockerAbi,
          functionName: "seed",
          args: [BigInt(id), plan.sets, plan.usdgToPools, positions],
          chainId: TARGET_CHAIN_ID,
        } as never);
      },
    },
  ];
}
