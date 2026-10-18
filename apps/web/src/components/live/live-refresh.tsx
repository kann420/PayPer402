'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

const DEBOUNCE_MS = 800;
const POLL_MS = 15_000;
const RETRY_MS = 3_000;

/**
 * Live refresh (design spec §13): listens to `/api/events` and refreshes the server components on
 * any event, debounced by 800 ms. After a reconnect it refreshes once, because events are not
 * replayed. If the relay answers 429, it polls every 15 s while the page is visible.
 */
export function LiveRefresh({ scope, onEvent }: { scope: 'operator' | 'seller'; onEvent?: (type: string) => void }) {
  const router = useRouter();
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let stopped = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let controller: AbortController | undefined;
    let connectedBefore = false;

    const refresh = () => {
      if (debounce !== undefined) clearTimeout(debounce);
      debounce = setTimeout(() => router.refresh(), DEBOUNCE_MS);
    };

    const startPolling = () => {
      if (poll !== undefined) return;
      poll = setInterval(() => {
        if (document.visibilityState === 'visible') router.refresh();
      }, POLL_MS);
    };

    const connect = async () => {
      if (stopped) return;
      controller = new AbortController();
      try {
        const res = await fetch(`/api/events?scope=${scope}`, { signal: controller.signal, cache: 'no-store' });
        if (res.status === 429) {
          startPolling();
          return;
        }
        if (!res.ok || res.body === null) throw new Error(`events ${res.status}`);
        if (connectedBefore) refresh();
        connectedBefore = true;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event = block
              .split('\n')
              .find((line) => line.startsWith('event: '))
              ?.slice(7);
            if (event !== undefined) {
              onEventRef.current?.(event);
              refresh();
            }
          }
        }
      } catch {
        // Reconnect below.
      }
      if (!stopped) retry = setTimeout(() => void connect(), RETRY_MS);
    };

    void connect();
    return () => {
      stopped = true;
      controller?.abort();
      if (debounce !== undefined) clearTimeout(debounce);
      if (retry !== undefined) clearTimeout(retry);
      if (poll !== undefined) clearInterval(poll);
    };
  }, [router, scope]);

  return null;
}
