import type { Metadata } from "next";
import { ThemeProvider, themeScript } from "@/components/marketing/ThemeProvider";
import { CustomCursor } from "@/components/marketing/primitives";
import "@/styles/marketing/tokens.css";
import "@/styles/marketing/site.css";
import "@/styles/marketing/sections.css";

export const metadata: Metadata = {
  title: "Prio — Plan better. Track smarter. Deliver faster.",
  description:
    "Prio brings projects, issues, teams, priorities, and progress into one beautifully simple workspace.",
};

/**
 * Marketing shell.
 *
 * Separate from the application layout: this tree is public, themed, and has no
 * session, sidebar or database access. The theme script runs before paint so
 * the correct palette is already applied on first render.
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider>
      <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      <div className="prio-site">
        <CustomCursor />
        {children}
      </div>
    </ThemeProvider>
  );
}
