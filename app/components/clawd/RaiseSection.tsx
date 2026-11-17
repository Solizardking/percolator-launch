"use client";

import { FC } from "react";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { RaiseNote } from "@/components/clawd/RaiseNote";
import { BuyClawdWidget } from "@/components/clawd/BuyClawdWidget";

/**
 * Homepage mainnet-raise section: the live "SOL of fees away from
 * deploying" note beside the buy-$CLAWD widget, so the ask and the
 * action sit together.
 */
export const RaiseSection: FC = () => {
  return (
    <section className="relative py-10">
      <div className="mx-auto max-w-[1100px] px-6">
        <ScrollReveal>
          <div className="mb-10 text-center">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              {"// deploy mainnet"}
            </div>
            <h2
              className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              Percolator mainnet is funded by $CLAWD fees.{" "}
              <span className="font-normal text-[var(--text-muted)]">
                Not by a raise.
              </span>
            </h2>
          </div>
        </ScrollReveal>
        <ScrollReveal>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <RaiseNote />
            <BuyClawdWidget />
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
};
