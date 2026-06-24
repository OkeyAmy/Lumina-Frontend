"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const ACTIVITY_EVENTS = ["mousemove", "keydown", "touchstart", "click", "scroll"] as const;

export function useIdleDetector(timeoutMs: number = 15 * 60 * 1000) {
  const [isIdle, setIsIdle] = useState(false);
  const [idleTime, setIdleTime] = useState(0);
  const lastActivityRef = useRef(Date.now());
  const idleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef(timeoutMs);

  timeoutRef.current = timeoutMs;

  const resetIdleTimer = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIdleTime(0);
    setIsIdle(false);
  }, []);

  useEffect(() => {
    const handleActivity = () => {
      lastActivityRef.current = Date.now();
      setIsIdle(false);
    };

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, handleActivity, { passive: true });
    }

    idleTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current;
      setIdleTime(elapsed);
      if (elapsed >= timeoutRef.current) {
        setIsIdle(true);
      }
    }, 1000);

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, handleActivity);
      }
      if (idleTimerRef.current) {
        clearInterval(idleTimerRef.current);
      }
    };
  }, []);

  return { isIdle, idleTime, resetIdleTimer };
}
