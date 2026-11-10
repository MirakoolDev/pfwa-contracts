"use client";
import { useState } from "react";

/** Ethos logo from their public brand kit — export the mark as SVG to this path. */
const ETHOS_LOGO = "/ethos-logo.svg";

/**
 * A creator's Ethos credibility score as a pill: the score, then the Ethos mark,
 * linking to their Ethos profile. Falls back to the word "ETHOS" if the logo
 * file is missing or fails to load.
 */
export default function EthosScore({ score, href }: { score: number; href: string }) {
  const [logoFailed, setLogoFailed] = useState(false);

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Ethos credibility score: ${score}`}
      className="flex-shrink-0 inline-flex items-center gap-1 bg-[#18181b] border border-white/20 rounded-full px-2 py-0.5 shadow-sm hover:scale-105 transition-transform"
    >
      <span className="font-heading font-bold text-[10px] tracking-wide text-white tabular-nums">{score}</span>
      {logoFailed ? (
        <span className="font-mono text-[8px] font-bold tracking-widest text-neutral-300">ETHOS</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={ETHOS_LOGO} alt="Ethos" className="h-2.5 w-auto" onError={() => setLogoFailed(true)} />
      )}
    </a>
  );
}
