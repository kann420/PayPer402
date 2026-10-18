'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, paths } from './icons';

export interface ToastInput {
  text: string;
  icon?: 'check' | 'pause' | 'copy' | 'error';
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<(toast: ToastInput) => void>(() => {});

/** Shows a toast: bottom right, 4 seconds, `role="status"`, dismissible (design spec §8.6). */
export function useToast(): (toast: ToastInput) => void {
  return useContext(ToastContext);
}

function ToastIcon({ icon }: { icon: ToastInput['icon'] }) {
  if (icon === 'pause') {
    return (
      <Icon size={18} fill="#C5CEC9" stroke="none">
        {paths.pause}
      </Icon>
    );
  }
  if (icon === 'error') {
    return (
      <Icon size={18} stroke="#FF9C8F" strokeWidth={2.4}>
        {paths.close}
      </Icon>
    );
  }
  if (icon === 'copy') {
    return (
      <Icon size={18} stroke="#2BE38A">
        {paths.copy}
      </Icon>
    );
  }
  return (
    <Icon size={18} stroke="#2BE38A" strokeWidth={2.6}>
      {paths.check}
    </Icon>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const show = useCallback(
    (toast: ToastInput) => {
      counter.current += 1;
      const id = counter.current;
      setItems((list) => [...list.slice(-2), { ...toast, id }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), 4000),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
    };
  }, []);

  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-6 bottom-6 z-[90] flex flex-col items-end gap-2.5">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className="pg-toast pointer-events-auto flex max-w-[380px] items-center gap-2.5 rounded-xl bg-ink-950 px-4 py-3 text-[15px] text-white shadow-toast"
          >
            <ToastIcon icon={t.icon} />
            <span>{t.text}</span>
            {t.action === undefined ? null : (
              <button
                type="button"
                className="ml-auto border-0 bg-transparent text-[13px] font-semibold text-meter-400"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className={`${t.action === undefined ? 'ml-auto' : ''} border-0 bg-transparent pl-1 text-[13px] text-ink-400`}
              onClick={() => dismiss(t.id)}
            >
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
