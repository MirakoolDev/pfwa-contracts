"use client";
// Live progress for a Pay from any chain order, as a modal: each step ticks off as the page's poll sees it happen
// (payment sent, NEAR Intents swapping, USDG at the order's address, tokens bought). If the USDG has been waiting and
// the relayer hasn't bought yet, the buyer can finish it from their own wallet: the forwarder's execute (or refund,
// after the deadline) is open to anyone, and only ever pays the order's own wallet.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ExternalLink, Loader2, X } from "lucide-react";
import { robinhoodChain } from "@/lib/config";

const EXPLORER = robinhoodChain.blockExplorers.default.url;
/** Seconds the USDG may wait for the relayer before the page offers to finish from the wallet. */
export const FINISH_AFTER = 30;

type State = "todo" | "active" | "done" | "failed";
export type ProgressView = {
  outcomeName: string; amountText: string; symbol: string; chain: string;
  sentTx?: string; sentAt?: number; status?: string | null; action?: string; tx?: string; note?: string;
  arrivedAt?: number; minOutText: string; usdgMinText: string; deposit: string;
};

/** Minutes after sending with no deposit seen before the window offers to start over. */
const NO_DEPOSIT_AFTER = 4;

export default function IntentProgress({ v, onClose, onFinish, finishing, finishErr, onStartOver }: {
  v: ProgressView; onClose: () => void; onFinish: () => void; finishing: boolean; finishErr: string | null; onStartOver?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const a = v.action ?? "";
  const s = v.status ?? "";
  const arrived = ["execute", "refund", "done", "refunded_onchain"].includes(a);
  const swapping = s === "KNOWN_DEPOSIT_TX" || s === "PROCESSING";
  const swapped = arrived || s === "SUCCESS";
  const failed = a === "failed" || a === "refunded" || a === "expired";
  const waited = v.arrivedAt ? Math.max(0, Math.floor((now - v.arrivedAt) / 1000)) : 0;
  const refunding = a === "refund" || a === "refunded_onchain";
  const finished = a === "done" || a === "refunded_onchain";

  const steps: { label: string; detail?: React.ReactNode; state: State }[] = [
    {
      label: `Send ${v.amountText} ${v.symbol} on ${v.chain}`,
      detail: v.sentTx ? <span className="break-all">Sent: {v.sentTx}</span> : swapping || swapped ? "Deposit seen" : "Waiting for your deposit",
      state: v.sentTx || swapping || swapped ? "done" : "active",
    },
    {
      label: "NEAR Intents swaps it into USDG",
      detail: swapped ? "Swapped" : failed ? "NEAR Intents refunds you on the chain you paid from" : swapping ? "Swapping across chains, usually about a minute" : undefined,
      state: swapped ? "done" : failed ? "failed" : swapping || v.sentTx ? "active" : "todo",
    },
    {
      label: "USDG lands on Robinhood Chain",
      detail: arrived ? `At least ${v.usdgMinText} USDG at your order's address` : s === "SUCCESS" ? "Delivered; waiting for the chain to show it" : undefined,
      state: arrived ? "done" : s === "SUCCESS" ? "active" : "todo",
    },
    {
      label: refunding ? "Refund the USDG to your wallet" : `Buy at least ${v.minOutText} ${v.outcomeName}`,
      detail: a === "done"
        ? `Your ${v.outcomeName} tokens are in your wallet`
        : a === "refunded_onchain"
          ? "The price moved past your minimum, so the USDG went back to your wallet"
          : arrived ? `${v.note ?? "Buying"}${waited > 0 ? ` · ${waited}s` : ""}` : undefined,
      state: finished ? "done" : arrived ? "active" : "todo",
    },
  ];
  const canFinish = !finished && (a === "execute" || a === "refund") && (waited >= FINISH_AFTER || /Couldn't send|No keeper/.test(v.note ?? ""));

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="intent-progress-title" onClick={(e) => e.stopPropagation()} className="bg-white dark:bg-[#0a0a0a] border border-neutral-200 dark:border-neutral-800 p-5 max-w-sm w-full shadow-2xl">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 id="intent-progress-title" className="font-heading font-600 text-base text-black dark:text-white">
              {a === "done" ? "Bought" : a === "refunded_onchain" ? "Refunded" : `Buying ${v.outcomeName}`}
            </h2>
            <p className="font-mono text-[11px] text-neutral-500 mt-0.5">with {v.amountText} {v.symbol} on {v.chain} · NEAR Intents</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-black dark:hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <ol className="space-y-3">
          {steps.map((st, i) => (
            <li key={i} className="flex gap-3">
              <span className={`mt-0.5 w-5 h-5 flex-shrink-0 flex items-center justify-center rounded-full border ${
                st.state === "done" ? "bg-[#00cc6a] border-[#00cc6a] text-black" : st.state === "failed" ? "border-red-500 text-red-500" : st.state === "active" ? "border-black dark:border-white" : "border-neutral-300 dark:border-neutral-700"
              }`}>
                {st.state === "done" ? <Check className="w-3 h-3" /> : st.state === "active" ? <Loader2 className="w-3 h-3 animate-spin" /> : st.state === "failed" ? <X className="w-3 h-3" /> : <span className="font-mono text-[9px] text-neutral-500">{i + 1}</span>}
              </span>
              <div className="min-w-0">
                <p className={`font-mono text-xs ${st.state === "todo" ? "text-neutral-400" : "text-black dark:text-white"}`}>{st.label}</p>
                {st.detail && <p className="font-mono text-[10px] text-neutral-500 mt-0.5">{st.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
        {canFinish && (
          <div className="mt-4 p-3 border border-amber-500/30 bg-amber-500/[0.06] space-y-2">
            <p className="font-mono text-[11px] text-neutral-600 dark:text-neutral-300 leading-relaxed">
              The USDG is waiting at your order&apos;s address and our relayer hasn&apos;t finished it yet. Finish it yourself: one transaction on Robinhood Chain, and the {a === "refund" ? "USDG goes" : "tokens go"} to your wallet.
            </p>
            <button type="button" onClick={onFinish} disabled={finishing} className="w-full py-2.5 bg-black dark:bg-white text-white dark:text-black font-heading font-bold text-sm disabled:opacity-50">
              {finishing ? "Confirm in your wallet…" : a === "refund" ? "Refund from your wallet" : "Finish from your wallet"}
            </button>
            {finishErr && <p className="font-mono text-[11px] text-red-500">{finishErr}</p>}
          </div>
        )}
        {onStartOver && v.sentTx && !swapping && !swapped && !failed && v.sentAt && now - v.sentAt > NO_DEPOSIT_AFTER * 60_000 && (
          <div className="mt-4 p-3 border border-neutral-200 dark:border-neutral-800 space-y-2">
            <p className="font-mono text-[11px] text-neutral-600 dark:text-neutral-300 leading-relaxed">
              NEAR Intents hasn&apos;t seen your payment after {NO_DEPOSIT_AFTER} minutes. If your wallet shows it failed or is still pending, nothing was taken: start over.
            </p>
            <button type="button" onClick={onStartOver} className="w-full py-2.5 border border-neutral-300 dark:border-neutral-700 font-heading font-bold text-sm text-black dark:text-white hover:border-black dark:hover:border-white">Start over</button>
          </div>
        )}
        <div className="mt-4 flex items-center justify-between gap-3 font-mono text-[10px] text-neutral-500">
          <a href={`${EXPLORER}/address/${v.deposit}`} target="_blank" rel="noreferrer" className="underline">Order address</a>
          {v.tx && <a href={`${EXPLORER}/tx/${v.tx}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">Transaction <ExternalLink className="w-3 h-3" /></a>}
        </div>
        {finished && (
          <button type="button" onClick={onClose} className="mt-4 w-full py-2.5 bg-[#00ff87] text-black font-heading font-bold text-sm">Done</button>
        )}
      </div>
    </div>,
    document.body,
  );
}
