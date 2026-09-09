import { describe, expect, it } from "vitest";
import {
  isThemeChoice,
  resolveTheme,
  THEME_SCRIPT,
  THEME_STORAGE_KEY,
} from "@/components/theme/theme";

/**
 * What each theme choice paints.
 *
 * Prio is a light application: Light is the default, and System resolves to
 * Light as well. It does not follow `prefers-color-scheme`, because arriving
 * on a dark machine and being handed a dark application nobody asked for — with
 * no obvious sign that a Theme control exists — is how people ended up stuck in
 * it. Dark is a deliberate choice, and only a deliberate one.
 *
 * The pre-paint script is a string, so it is tested by running it: a stub
 * document and a stub localStorage, and then the attribute it left behind.
 * That is the thing that actually decides the first frame.
 */

/** Runs `THEME_SCRIPT` against a stored value, and reports what it painted. */
function paintedWith(stored: string | null): string | null {
  let attribute: string | null = null;

  const documentStub = {
    documentElement: {
      setAttribute(name: string, value: string) {
        if (name === "data-theme") attribute = value;
      },
    },
  };
  const storageStub = {
    getItem(key: string) {
      return key === THEME_STORAGE_KEY ? stored : null;
    },
  };

  new Function("document", "localStorage", THEME_SCRIPT)(
    documentStub,
    storageStub,
  );
  return attribute;
}

describe("resolveTheme", () => {
  it("paints Light for Light", () => {
    expect(resolveTheme("light")).toBe("light");
  });

  it("paints Light for System — never Dark", () => {
    expect(resolveTheme("system")).toBe("light");
  });

  it("paints Light when nothing has been chosen", () => {
    expect(resolveTheme(null)).toBe("light");
  });

  it("paints Dark only when Dark was chosen", () => {
    expect(resolveTheme("dark")).toBe("dark");
  });
});

describe("the pre-paint script", () => {
  it("writes the resolved theme for every stored value", () => {
    expect(paintedWith("light")).toBe("light");
    expect(paintedWith("dark")).toBe("dark");
    expect(paintedWith("system")).toBe("light");
    expect(paintedWith(null)).toBe("light");
  });

  it("never leaves the attribute off, which is what let the OS decide", () => {
    /* The dark rules in `theme-dark.css` are guarded on
       `:root:not([data-theme="light"])`, so an absent attribute on a dark
       machine painted the application dark. Every case now answers that
       guard. */
    for (const stored of ["light", "dark", "system", null, "nonsense"]) {
      expect(paintedWith(stored), `stored=${stored}`).not.toBeNull();
    }
  });

  it("reads a value it does not recognise as no preference", () => {
    expect(paintedWith("nonsense")).toBe("light");
  });

  it("survives storage that throws, as a private window's does", () => {
    let attribute: string | null = null;
    const documentStub = {
      documentElement: {
        setAttribute(name: string, value: string) {
          if (name === "data-theme") attribute = value;
        },
      },
    };
    const hostileStorage = {
      getItem() {
        throw new Error("storage is blocked");
      },
    };

    expect(() =>
      new Function("document", "localStorage", THEME_SCRIPT)(
        documentStub,
        hostileStorage,
      ),
    ).not.toThrow();
    expect(attribute).toBe("light");
  });
});

describe("the stored choice", () => {
  it("keeps all three, so System stays selectable", () => {
    for (const choice of ["light", "dark", "system"]) {
      expect(isThemeChoice(choice), choice).toBe(true);
    }
    expect(isThemeChoice("sepia")).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
  });
});
