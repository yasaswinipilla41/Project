import Link from "next/link";
import { IconChevronLeft } from "@/components/ui/Icon";

/**
 * "Back to …" for a detail page.
 *
 * Deliberately a real link to a named destination rather than
 * `history.back()`. A detail page is reached as often from a notification, a
 * search result or a pasted key as from the list itself, and in those cases
 * "back" means somewhere outside Prio entirely — or nowhere at all. Naming the
 * destination means the control does the same thing however you arrived.
 */
export function BackLink({
  href,
  label,
  tone = "default",
}: {
  href: string;
  label: string;
  /** `sprint` is the Sprint pages' purple; every other page keeps the default. */
  tone?: "default" | "sprint";
}) {
  return (
    <Link
      href={href}
      className={tone === "sprint" ? "prio-backlink prio-backlink--sprint" : "prio-backlink"}
    >
      <IconChevronLeft size={14} />
      {label}
    </Link>
  );
}
