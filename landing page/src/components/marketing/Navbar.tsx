"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PrioLogo } from "@/components/brand/PrioLogo";
import { NAV_LINKS } from "@/lib/marketing-content";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { Magnetic } from "./primitives";

/**
 * Sticky navigation (§6).
 *
 * Transparent at the top of the page, then condensing into a glass bar with a
 * border and a slightly reduced height once scrolled — the state is a single
 * data attribute so the whole transition lives in CSS.
 */
export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<string>("");

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Highlights the link for whichever section is currently in view.
  useEffect(() => {
    const ids = NAV_LINKS.map((l) => l.href.replace("#", ""));
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveSection(entry.target.id);
        }
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );

    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, []);

  // A menu that stays open behind a navigation is a trap; close it on route
  // change and lock the page behind it while it is open.
  useEffect(() => {
    if (!menuOpen) return;

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <header className="site-nav" data-scrolled={scrolled} data-open={menuOpen}>
      <div className="site-nav__inner">
        <Link href="/landing" className="site-nav__brand" aria-label="Prio home">
          <PrioLogo variant="lockup" size="sm" decorative />
        </Link>

        <nav className="site-nav__links" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="site-nav__link"
              data-active={activeSection === link.href.replace("#", "")}
            >
              {link.label}
              <span className="site-nav__underline" aria-hidden />
            </a>
          ))}
        </nav>

        <div className="site-nav__actions">
          <ThemeSwitcher />

          <Link href="/sign-in" className="site-btn site-btn--ghost">
            Sign in
          </Link>

          <Magnetic>
            <Link
              href="/sign-in"
              className="site-btn site-btn--primary"
              data-cursor="cta"
            >
              Get Started
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <path
                  d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          </Magnetic>

          <button
            type="button"
            className="site-nav__toggle"
            aria-expanded={menuOpen}
            aria-controls="site-mobile-menu"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="site-nav__bar" />
            <span className="site-nav__bar" />
          </button>
        </div>
      </div>

      <div
        id="site-mobile-menu"
        className="site-nav__mobile"
        hidden={!menuOpen}
      >
        <nav aria-label="Mobile">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="site-nav__mobile-link"
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="site-nav__mobile-actions">
          <Link
            href="/sign-in"
            className="site-btn site-btn--ghost"
            onClick={() => setMenuOpen(false)}
          >
            Sign in
          </Link>
          <Link
            href="/sign-in"
            className="site-btn site-btn--primary"
            onClick={() => setMenuOpen(false)}
          >
            Get Started
          </Link>
        </div>
      </div>
    </header>
  );
}
