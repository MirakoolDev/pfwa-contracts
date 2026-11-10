"use client";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, X, ExternalLink, AlertTriangle, Minus } from "lucide-react";
import { robinhoodChain } from "@/lib/config";

export type TxStepState = "waiting" | "wallet" | "pending" | "done" | "skipped" | "failed";

export interface TxStep {
  id: string;
  label: string;
  state: TxStepState;
  /** Shown under the label, e.g. why a step was skipped. */
  detail?: string;
  hash?: `0x${string}`;
}

export interface TxFlow {
  title: string;
  steps: TxStep[];
  /** True while a step is still to run; the modal can't be closed meanwhile. */
  running: boolean;
  error?: string;
  /** Where the user's funds are after a partial failure. */
  recovery?: string;
  retry?: { label: string; run: () => void };
}

const EXPLORER = robinhoodChain.blockExplorers.default.url;

const STATE_TEXT: Partial<Record<TxStepState, string>> = {
  wallet: "Confirm in your wallet…",
  pending: "Confirming onchain…",
  skipped: "Skipped",
  failed: "Didn't go through",
};

function StepIcon({ state, index }: { state: TxStepState; index: number }) {
  const base = "w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 font-mono text-[10px] font-bold";
  if (state === "done") return <span className={`${base} bg-[#00ff87] text-black`}><Check className="w-3.5 h-3.5" /></span>;
  if (state === "failed") return <span className={`${base} bg-red-500 text-white`}><X className="w-3.5 h-3.5" /></span>;
  if (state === "skipped") return <span className={`${base} bg-neutral-200 dark:bg-neutral-800 text-neutral-500`}><Minus className="w-3.5 h-3.5" /></span>;
  if (state === "wallet" || state === "pending") {
    return <span className={`${base} border border-black dark:border-white text-black dark:text-white`}><Loader2 className="w-3.5 h-3.5 animate-spin" /></span>;
  }
  return <span className={`${base} border border-neutral-300 dark:border-neutral-700 text-neutral-400`}>{index + 1}</span>;
}

/**
 * Progress for an order that takes more than one wallet confirmation: each
 * step, where it's at, and a link to it on the explorer. If a later step fails
 * after an earlier one went through, says where the funds are and offers a retry.
 */
export default function TxStepsModal({ flow, onClose }: { flow: TxFlow; onClose: () => void }) {
  const { title, steps, running, error, recovery, retry } = flow;
  const confirmations = steps.filter((s) => s.state !== "skipped").length;
  const finished = !running && !error;

  useEffect(() => {
    if (running) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, onClose]);

  // Portalled to <body> so a transformed parent (the mobile drawer) can't clip it.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tx-steps-title"
        className="bg-white dark:bg-[#0a0a0a] border border-neutral-200 dark:border-neutral-800 p-5 max-w-sm w-full shadow-2xl relative"
      >
        {!running && (
          <button onClick={onClose} aria-label="Close" className="absolute top-4 right-4 text-neutral-400 hover:text-black dark:hover:text-white">
            <X className="w-4 h-4" />
          </button>
        )}
        <h3 id="tx-steps-title" className="font-heading font-bold text-base text-black dark:text-white pr-6">{title}</h3>
        <p className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest mt-1">
          {confirmations} wallet confirmation{confirmations === 1 ? "" : "s"}
        </p>

        <ol className="mt-4 space-y-3" aria-live="polite">
          {steps.map((s, i) => (
            <li key={s.id} className="flex items-start gap-3">
              <StepIcon state={s.state} index={i} />
              <div className="min-w-0 flex-1 pt-0.5">
                <p className={`font-heading font-600 text-sm leading-tight ${s.state === "waiting" || s.state === "skipped" ? "text-neutral-400" : "text-black dark:text-white"}`}>
                  {s.label}
                </p>
                {(s.detail || STATE_TEXT[s.state]) && (
                  <p className={`font-mono text-[10px] mt-0.5 ${s.state === "failed" ? "text-red-500" : "text-neutral-500"}`}>
                    {s.detail || STATE_TEXT[s.state]}
                  </p>
                )}
              </div>
              {s.hash && (
                <a
                  href={`${EXPLORER}/tx/${s.hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pt-1 text-neutral-400 hover:text-black dark:hover:text-white"
                  aria-label={`View ${s.label} on the explorer`}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </li>
          ))}
        </ol>

        {error && (
          <div className="mt-4 border border-red-500/30 bg-red-500/10 p-3 rounded-lg flex gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="min-w-0 font-mono text-[11px] leading-relaxed">
              {recovery && <p className="text-black dark:text-white">{recovery}</p>}
              <p className="text-red-500 break-words">{error}</p>
            </div>
          </div>
        )}

        {running ? (
          <p className="mt-4 font-mono text-[10px] text-neutral-500 leading-relaxed">
            Keep this open and confirm each step in your wallet.
          </p>
        ) : (
          <div className="mt-4 flex gap-2">
            {error && retry && (
              <button
                onClick={retry.run}
                className="flex-1 py-2.5 font-heading font-bold text-sm bg-black dark:bg-white text-white dark:text-black hover:opacity-90 transition-opacity"
              >
                {retry.label}
              </button>
            )}
            <button
              onClick={onClose}
              className={`flex-1 py-2.5 font-heading font-bold text-sm transition-colors ${finished ? "bg-[#00ff87] text-black hover:opacity-90" : "border border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:text-black dark:hover:text-white"}`}
            >
              {finished ? "Done" : error && recovery ? "Keep ETH" : "Close"}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
