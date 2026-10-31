'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { NO_HOME_PERMISSIONS, type ApiResponse, type HomePermissions } from '@rete/shared';
import apiClient from '@/lib/api-client';
import { isAxiosError } from 'axios';
import { useSession } from '@/features/auth/hooks/use-session';

const Context = createContext({ ...NO_HOME_PERMISSIONS, refresh: async () => {} });
export function HomePermissionsProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const accountId = user?.id ?? null;
  const [snapshot, setSnapshot] = useState({
    accountId,
    permissions: NO_HOME_PERMISSIONS as HomePermissions,
  });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!accountId) {
      setSnapshot({ accountId, permissions: NO_HOME_PERMISSIONS });
      return;
    }
    try {
      const { data } = await apiClient.get<ApiResponse<HomePermissions>>('/home/permissions');
      if (request === generation.current) setSnapshot({ accountId, permissions: data.data });
    } catch {
      if (request === generation.current)
        setSnapshot({ accountId, permissions: NO_HOME_PERMISSIONS });
    }
  }, [accountId]);
  useEffect(() => {
    let canceled = false;
    const requests = generation;
    void Promise.resolve().then(() => {
      if (!canceled) void refresh();
    });
    return () => {
      canceled = true;
      requests.current++;
    };
  }, [refresh]);
  useEffect(() => {
    const interceptor = apiClient.interceptors.response.use(undefined, (error: unknown) => {
      if (
        isAxiosError(error) &&
        error.response?.status === 403 &&
        error.config?.url !== '/home/permissions'
      )
        void refresh();
      return Promise.reject(error);
    });
    return () => apiClient.interceptors.response.eject(interceptor);
  }, [refresh]);
  useEffect(() => {
    const onFocus = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);
  const permissions = snapshot.accountId === accountId ? snapshot.permissions : NO_HOME_PERMISSIONS;
  return <Context.Provider value={{ ...permissions, refresh }}>{children}</Context.Provider>;
}
export const useHomePermissions = () => useContext(Context);
