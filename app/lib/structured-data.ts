import { SITE_NAME, SITE_URL } from "@/lib/seo";

const LOGO_URL = `${SITE_URL}/icon.png`;
const SAME_AS = [
  "https://x.com/0rdlibrary",
  "https://github.com/solizardking",
  "https://discord.gg/fJa4BDBxPN",
];

/** Organization schema — sitewide brand/entity signals. */
export function organizationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    logo: LOGO_URL,
    description:
      "Permissionless perpetual futures for any Solana token — fully on-chain, transparent, and self-custodial.",
    sameAs: SAME_AS,
  };
}

/** WebSite schema — names the site entity for the homepage. */
export function websiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: SITE_URL,
    publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
  };
}

/** BreadcrumbList schema for nested pages. */
export function breadcrumbSchema(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: `${SITE_URL}${it.path}`,
    })),
  };
}

/** FinancialProduct schema for a perpetual market page. */
export function marketSchema(opts: { symbol: string; path: string }) {
  const name = opts.symbol ? `${opts.symbol}-PERP Perpetual Futures` : "Perpetual Futures Market";
  return {
    "@context": "https://schema.org",
    "@type": "FinancialProduct",
    name,
    category: "Perpetual Futures",
    url: `${SITE_URL}${opts.path}`,
    provider: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
    description: opts.symbol
      ? `On-chain ${opts.symbol} perpetual futures market on Percolator — permissionless and self-custodial, on Solana.`
      : "On-chain perpetual futures market on Percolator — permissionless and self-custodial, on Solana.",
  };
}
