"use client";
// The connected trader's limit orders in this market: cancel open ones, withdraw filled ones.
import { useAccount, useWriteContract } from "wagmi";
import { TARGET_CHAIN_ID } from "@/lib/config";
import { OB } from "@/lib/orderbook/config";
import { obLimitOrdersAbi } from "@/lib/orderbook/abi";
import { fmtAmount, fmtPrice } from "@/lib/orderbook/math";
import type { BookMarket } from "@/lib/orderbook/read";
import type { MyOrder } from "@/lib/orderbook/orders";
import { useMyOrders } from "@/hooks/useBook";
import { Panel } from "./ui";
import { useTxFlow } from "./useTxFlow";

export default function MyOrders({ market, onDone }: { market: BookMarket; onDone: () => void }) {
  const { address } = useAccount();
  const { data } = useMyOrders(market, address);
  const { writeContractAsync } = useWriteContract();
  const { start, modal, running } = useTxFlow(onDone);
  if (!address || !OB.limitOrders) return null;
  const lo = OB.limitOrders;
  const orders = data ?? [];

  const cancel = (o: MyOrder) =>
    start("Cancel the order", [{
      id: "cancel",
      label: `Cancel: ${o.side} ${o.outcome.name} at ${fmtPrice(o.price)}`,
      run: () => writeContractAsync({ address: lo, abi: obLimitOrdersAbi, functionName: "cancel", args: [o.key, o.tickLower, o.zeroForOne, address], chainId: TARGET_CHAIN_ID }),
    }]);
  const withdraw = (o: MyOrder) =>
    start("Withdraw a filled order", [{
      id: "withdraw",
      label: `Withdraw ${fmtAmount(o.proceeds)} ${o.side === "buy" ? o.outcome.name : "USDG"}`,
      run: () => writeContractAsync({ address: lo, abi: obLimitOrdersAbi, functionName: "withdraw", args: [o.epoch, address], chainId: TARGET_CHAIN_ID }),
    }]);

  return (
    <Panel title="Your limit orders">
      {modal}
      {orders.length === 0 ? (
        <p className="font-mono text-xs text-neutral-500">No open orders in this market.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-neutral-500 text-left">
                <th className="pb-2 font-normal">Order</th>
                <th className="pb-2 font-normal text-right">Price</th>
                <th className="pb-2 font-normal text-right">Amount</th>
                <th className="pb-2 font-normal text-right">Status</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.epoch.toString()} className="border-t border-neutral-100 dark:border-neutral-800/60">
                  <td className="py-2 text-black dark:text-white">
                    <span className={o.side === "buy" ? "text-[#00cc6a] dark:text-[#00ff87]" : "text-red-500"}>{o.side === "buy" ? "Buy" : "Sell"}</span> {o.outcome.name}
                  </td>
                  <td className="py-2 text-right tabular-nums">{fmtPrice(o.price)}</td>
                  <td className="py-2 text-right tabular-nums">{fmtAmount(o.amountIn)} {o.side === "buy" ? "USDG" : o.outcome.name}</td>
                  <td className="py-2 text-right">
                    {o.status === "filled" ? (
                      <span className="text-[#00cc6a] dark:text-[#00ff87]">Filled: {fmtAmount(o.proceeds)} {o.side === "buy" ? o.outcome.name : "USDG"}</span>
                    ) : (
                      <span className="text-neutral-500">Open</span>
                    )}
                  </td>
                  <td className="py-2 pl-3 text-right">
                    <button
                      type="button"
                      disabled={running}
                      onClick={() => void (o.status === "filled" ? withdraw(o) : cancel(o))}
                      className="px-2.5 py-1 border border-neutral-200 dark:border-neutral-800 text-[10px] uppercase tracking-wider text-neutral-600 dark:text-neutral-300 hover:border-black dark:hover:border-white disabled:opacity-40"
                    >
                      {o.status === "filled" ? "Withdraw" : "Cancel"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
