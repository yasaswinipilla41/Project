"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { IconClose, IconSearch } from "@/components/ui/Icon";

/**
 * The search box. Focused on mount and reachable from anywhere with "/", so the
 * page is usable from the keyboard alone (§42).
 */
export function SearchForm({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typingElsewhere =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;

      if (event.key === "/" && !typingElsewhere) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = value.trim();
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  }

  /*
   * Clearing takes the results with it. Emptying the field alone would leave
   * the previous results on screen under an empty box, still described by a
   * `?q=` in the address bar that no longer matches what is typed.
   */
  function clear() {
    setValue("");
    router.push("/search");
    inputRef.current?.focus();
  }

  return (
    <form onSubmit={onSubmit} role="search" className="prio-searchpage__form">
      <div className="prio-search">
        <span className="prio-search__icon">
          <IconSearch />
        </span>
        <input
          ref={inputRef}
          type="search"
          className="prio-input prio-input--lg"
          placeholder="Search issues, bugs, projects and people…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Search Prio"
        />
        {value ? (
          <button
            type="button"
            className="prio-search__clear"
            onClick={clear}
            aria-label="Clear search"
            title="Clear search"
          >
            <IconClose size={14} />
          </button>
        ) : (
          <kbd className="prio-kbd prio-search__kbd" aria-hidden>
            /
          </kbd>
        )}
      </div>
    </form>
  );
}
