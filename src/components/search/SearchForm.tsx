"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { IconClose, IconSearch } from "@/components/ui/Icon";

interface Suggestion {
  kind: "issue" | "project" | "person";
  label: string;
  hint: string;
  href: string;
}

const KIND_LABEL: Record<Suggestion["kind"], string> = {
  issue: "Issue",
  project: "Project",
  person: "Person",
};

/**
 * The search box. Focused on mount and reachable from anywhere with "/", so the
 * page is usable from the keyboard alone (§42).
 *
 * Typing offers suggestions underneath it. They come from
 * `/api/search/suggest`, which matches with the same predicates and the same
 * scopes this page's own results use, so a suggestion can never name something
 * the results below would refuse to show. Pressing Enter still runs the full
 * search on this page; the suggestions are a shortcut past it, not a
 * replacement for it.
 */
export function SearchForm({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  /*
   * Debounced, and every in-flight request is abandoned when the next
   * keystroke arrives -- both so the server is not asked once per character,
   * and so a slow early reply cannot land after a later one and show
   * suggestions for a query that is no longer in the box.
   */
  useEffect(() => {
    const query = value.trim();
    /* Nothing to ask about. Whatever was fetched last stays in state but is
       not rendered -- `listOpen` below requires a non-empty query -- which
       keeps this effect free of the synchronous state writes that would make
       every keystroke render twice. */
    if (query.length === 0) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/search/suggest?q=${encodeURIComponent(query)}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const body = (await response.json()) as { suggestions?: Suggestion[] };
        setSuggestions(body.suggestions ?? []);
        setHighlight(-1);
        setOpen(true);
      } catch {
        // Aborted, or the network is unavailable. The box still works: Enter
        // runs the real search regardless of whether suggestions arrived.
      }
    }, 180);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [value]);

  const choose = useCallback(
    (suggestion: Suggestion) => {
      setOpen(false);
      router.push(suggestion.href);
    },
    [router],
  );

  /* One source of truth for whether the list is showing, so the keyboard and
     the markup can never disagree about it. */
  const listOpen = open && value.trim().length > 0 && suggestions.length > 0;

  function onKeyDownInput(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (!listOpen) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((i) => (i + 1) % suggestions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((i) => (i - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "Enter" && highlight >= 0) {
      // Only when something is picked; otherwise Enter submits the form and
      // runs the full search, exactly as it did before.
      const picked = suggestions[highlight];
      if (picked) {
        event.preventDefault();
        choose(picked);
      }
    }
  }

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
          onKeyDown={onKeyDownInput}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          /* Let a click on a suggestion land before the list disappears. */
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          aria-label="Search Prio"
          /* Deliberately not `role="combobox"`: that would replace the field's
             native `searchbox` role, which is what this control is and what
             everything else already identifies it by. The relationship to the
             list is described with the properties below instead. */
          aria-autocomplete="list"
          /* `aria-expanded` is deliberately absent: it is not supported on
             this field's implicit `searchbox` role, and claiming the
             `combobox` role instead would take that role away from a control
             that genuinely is a search box. `aria-activedescendant` is
             supported here and is what actually announces the highlighted
             suggestion. */
          aria-controls="search-suggestions"
          aria-activedescendant={
            highlight >= 0 ? `search-suggestion-${highlight}` : undefined
          }
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

        {listOpen ? (
          <ul
            className="prio-suggestions"
            id="search-suggestions"
            role="listbox"
            aria-label="Search suggestions"
          >
            {suggestions.map((suggestion, index) => (
              <li key={`${suggestion.kind}-${suggestion.href}-${index}`}>
                <button
                  type="button"
                  id={`search-suggestion-${index}`}
                  role="option"
                  aria-selected={index === highlight}
                  className="prio-suggestions__item"
                  data-active={index === highlight || undefined}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(suggestion)}
                >
                  <span className="prio-suggestions__kind">
                    {KIND_LABEL[suggestion.kind]}
                  </span>
                  <span className="prio-suggestions__label prio-truncate">
                    {suggestion.label}
                  </span>
                  <span className="prio-suggestions__hint prio-truncate">
                    {suggestion.hint}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </form>
  );
}
