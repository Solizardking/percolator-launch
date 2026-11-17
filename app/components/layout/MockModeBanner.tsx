"use client";

import { isMockMode } from "@/lib/mock-mode";

/**
 * Loud, non-dismissible banner shown whenever mock mode is active
 * (NEXT_PUBLIC_MOCK_MODE=true or ?mock=1). Mock mode must never
 * silently present simulated prices/markets as live.
 */
export function MockModeBanner() {
  if (!isMockMode()) return null;
  return (
    <div
      role="alert"
      className="w-full border-b border-yellow-500/50 bg-yellow-500/15 px-4 py-2 text-center text-[11px] font-bold uppercase tracking-[0.15em] text-yellow-500"
    >
      ⚠ Mock mode — markets &amp; prices on this page are simulated, not live
    </div>
  );
}
