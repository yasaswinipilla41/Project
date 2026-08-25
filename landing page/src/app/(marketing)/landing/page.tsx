import { Navbar } from "@/components/marketing/Navbar";
import { Hero } from "@/components/marketing/Hero";
import {
  FeatureGrid,
  SocialProof,
  ValueSection,
} from "@/components/marketing/Sections";
import {
  IssueDetail,
  KanbanPreview,
  Workflow,
} from "@/components/marketing/Showcase";
import {
  AnalyticsPreview,
  AutomationSection,
  CollaborationSection,
  FinalCTA,
  Footer,
} from "@/components/marketing/Closing";

/**
 * The Prio landing page.
 *
 * Section order alternates light and tinted/dark grounds so the page reads as a
 * sequence of scenes rather than one long scroll (§27).
 */
export default function LandingPage() {
  return (
    <>
      <Navbar />
      <main id="main">
        <Hero />
        <SocialProof />
        <ValueSection />
        <KanbanPreview />
        <FeatureGrid />
        <IssueDetail />
        <AnalyticsPreview />
        <Workflow />
        <CollaborationSection />
        <AutomationSection />
        <FinalCTA />
      </main>
      <Footer />
    </>
  );
}
