import type { Metadata } from "next";

/**
 * Shared metadata helpers for per-route SEO.
 *
 * Most pages are `"use client"` components and cannot `export const metadata`.
 * The fix is a sibling server-component `layout.tsx` per route that re-exports
 * `pageMetadata({...})`. `metadataBase` (set in app/layout.tsx) is
 * https://percolator.trade, so relative canonical paths resolve correctly.
 */

export const SITE_NAME = "Percolator";
export const SITE_URL = "https://percolator.trade";
export const TWITTER_HANDLE = "@0rdlibrary";

type PageMetaOpts = {
  /** Bare page title (no brand). The root template appends " | Percolator". */
  title: string;
  description: string;
  /** Absolute path beginning with "/", e.g. "/trade". Used for canonical + og:url. */
  path: string;
  /** Personalized/private pages should not be indexed. */
  noindex?: boolean;
  keywords?: string[];
};

export function pageMetadata({ title, description, path, noindex, keywords }: PageMetaOpts): Metadata {
  const ogTitle = `${title} | ${SITE_NAME}`;
  const url = `${SITE_URL}${path}`;
  return {
    title,
    description,
    ...(keywords ? { keywords } : {}),
    alternates: { canonical: path },
    openGraph: {
      title: ogTitle,
      description,
      url,
      siteName: SITE_NAME,
      type: "website",
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      site: TWITTER_HANDLE,
      title: ogTitle,
      description,
    },
    robots: noindex
      ? { index: false, follow: false, googleBot: { index: false, follow: false } }
      : { index: true, follow: true, googleBot: { index: true, follow: true } },
  };
}

/** Minimal passthrough layout body — routes render children unchanged. */
export type SeoLayoutProps = { children: React.ReactNode };
