/**
 * useAlertStore.ts
 * Zustand store that holds all alerts emitted by the alert pipeline.
 * Components subscribe here to get live, reactive alert data.
 */

import { create } from "zustand";
import { Alert } from "../services/alertPipeline";

interface AlertStore {
  alerts: Alert[];
  addAlert: (alert: Alert) => void;
  dismissAlert: (id: string) => void;
  clearAll: () => void;
}

export const useAlertStore = create<AlertStore>((set) => ({
  alerts: [],

  addAlert: (alert) =>
    set((state) => {
      // Guard against duplicates that slipped through (defensive)
      if (state.alerts.some((a) => a.id === alert.id)) return state;
      return { alerts: [alert, ...state.alerts].slice(0, 200) }; // cap at 200
    }),

  dismissAlert: (id) =>
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.id === id ? { ...a, dismissed: true } : a
      ),
    })),

  clearAll: () => set({ alerts: [] }),
}));