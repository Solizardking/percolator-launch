"use client";

// ─── VC deck ──────────────────────────────────────────────────────────────────
//
// Investor-facing order: problem + market + why-now + money + moat lead, the
// engine detail sits mid-deck. All slide components and styling come from
// ./_deck (the shared library) so facts live in exactly one place across the
// VC / technical / grants variants. Edit a slide there, every deck updates.

import {
  PitchDeck,
  type SlideDef,
  Slide01OneLiner,
  SlideProblem,
  Slide05Product,
  SlideOpportunity,
  Slide09WhyNow,
  SlideCompetition,
  SlideOrigin,
  Slide02Team,
  Slide03Traction,
  Slide06Money,
  SlideMathVC,
  SlideGTM,
  SlideRoadmapAsk,
  Slide13Contact,
} from "./_deck";

// Narrative spine: problem → fix → opportunity → why now → competition,
// then the credibility block (Toly → team → traction), then the economics
// and the plan. Moat is dropped here; Competition carries the defensibility
// point, and a separate Moat slide repeated it.
const SLIDES: SlideDef[] = [
  { id: 1, title: "One-Liner", component: Slide01OneLiner },
  { id: 2, title: "Problem", component: SlideProblem },
  { id: 3, title: "The Product", component: Slide05Product },
  { id: 4, title: "Opportunity", component: SlideOpportunity },
  { id: 5, title: "Why Now", component: Slide09WhyNow },
  { id: 6, title: "Competition", component: SlideCompetition },
  { id: 7, title: "Origin", component: SlideOrigin },
  { id: 8, title: "Team", component: Slide02Team },
  { id: 9, title: "Traction", component: Slide03Traction },
  { id: 10, title: "Business Model", component: Slide06Money },
  { id: 11, title: "How it stays safe", component: SlideMathVC },
  { id: 12, title: "Go-to-Market", component: SlideGTM },
  { id: 13, title: "Roadmap", component: SlideRoadmapAsk },
  { id: 14, title: "Contact", component: Slide13Contact },
];

export default function PitchVCPage() {
  return <PitchDeck slides={SLIDES} />;
}
