"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/Toast";
import { markNotificationRead } from "@/server/notifications";

export interface NewUserAlert {
  id: string;
  message: string;
}

/**
 * Pops one toast per unread "someone new joined" notification, admin-only.
 *
 * This is not a live/real-time feed — Prio has no socket or polling layer —
 * so "after the new user successfully signs in" means the next time this
 * admin loads a page. Each alert is marked read the moment its toast shows,
 * so it never appears again on a later refresh; the ref-based guard on top of
 * that stops the same alert firing twice within one already-open tab, since
 * this component stays mounted across client-side navigation.
 */
export function NewUserAlerts({ alerts }: { alerts: NewUserAlert[] }) {
  const { toast } = useToast();
  const shown = useRef(new Set<string>());

  useEffect(() => {
    for (const alert of alerts) {
      if (shown.current.has(alert.id)) continue;
      shown.current.add(alert.id);
      toast(alert.message, "info");
      void markNotificationRead(alert.id, true);
    }
  }, [alerts, toast]);

  return null;
}
