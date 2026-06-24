'use client';

import { useEffect, useRef, useState } from 'react';

interface WebGPUState {
  isSupported: boolean;
  isAvailable: boolean;
  error: string | null;
  checking: boolean;
}

/**
 * Detects WebGPU availability and provides initialization lifecycle.
 */
export function useWebGPUAvailable() {
  const [state, setState] = useState<WebGPUState>({
    isSupported: false,
    isAvailable: false,
    error: null,
    checking: true,
  });
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    let cancelled = false;

    async function checkAvailability() {
      // Check for navigator.gpu (WebGPU API surface)
      if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
        if (!cancelled) {
          setState({ isSupported: false, isAvailable: false, error: null, checking: false });
        }
        return;
      }

      try {
        const adapter = await navigator.gpu.requestAdapter({
          powerPreference: 'high-performance',
        });
        if (cancelled) return;

        if (!adapter) {
          setState({
            isSupported: true,
            isAvailable: false,
            error: 'No suitable GPU adapter found',
            checking: false,
          });
          return;
        }

        const device = await adapter.requestDevice({
          requiredFeatures: [],
          requiredLimits: {
            maxStorageBufferBindingSize: 64 * 1024 * 1024,
          },
        });

        if (cancelled) {
          device.destroy();
          return;
        }

        device.destroy();
        setState({
          isSupported: true,
          isAvailable: true,
          error: null,
          checking: false,
        });
      } catch (err) {
        if (!cancelled) {
          setState({
            isSupported: true,
            isAvailable: false,
            error: err instanceof Error ? err.message : 'WebGPU initialization failed',
            checking: false,
          });
        }
      }
    }

    checkAvailability();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
