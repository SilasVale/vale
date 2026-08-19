import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

interface ToastState {
  message: string;
  isError: boolean;
}

interface ToastCtx {
  toast: (msg: string, isError?: boolean) => void;
}

const ToastContext = createContext<ToastCtx>({ toast: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = useCallback((message: string, isError = false) => {
    setToast({ message, isError });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(id);
  }, [toast]);

  return (
    <ToastContext.Provider value={{ toast: showToast }}>
      {children}
      {toast && (
        <div className={`toast ${toast.isError ? "err" : ""}`}>
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
