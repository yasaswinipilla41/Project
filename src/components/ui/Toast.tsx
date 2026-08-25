"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IconClose, IconSuccess, IconWarning } from "@/components/ui/Icon";

/**
 * Success / error feedback for actions that complete without a page change
 * (§41). Announced politely to assistive technology.
 */

export type ToastTone = "success" | "error" | "info";

interface Toast {
  id: number;
  tone: ToastTone;
  message: ReactNode;
}

interface ToastContextValue {
  toast: (message: ReactNode, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: ReactNode, tone: ToastTone = "success") => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, tone, message }]);
      // Errors linger; successes get out of the way.
      window.setTimeout(() => dismiss(id), tone === "error" ? 7000 : 4500);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="prio-toast-region"
        role="status"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((t) => (
          <div key={t.id} className="prio-toast" data-tone={t.tone}>
            <span className="prio-toast__icon" aria-hidden>
              {t.tone === "error" ? <IconWarning /> : <IconSuccess />}
            </span>
            <div className="prio-toast__body">{t.message}</div>
            <button
              type="button"
              className="prio-toast__close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              <IconClose size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
