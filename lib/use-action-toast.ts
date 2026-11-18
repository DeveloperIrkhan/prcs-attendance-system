"use client";

import { useEffect, useRef } from "react";
import { toast } from "react-toastify";
import type { ActionState } from "./action-state";
export function useActionToast(state: ActionState, successText = "Done.") {
  const shown = useRef<ActionState | null>(null);

  useEffect(() => {
    if (state === shown.current) return;
    shown.current = state;

    if (state.error) {
      toast.error(state.error);
    } else if (state.ok) {
      toast.success(state.message ?? successText);
    }
  }, [state, successText]);
}
