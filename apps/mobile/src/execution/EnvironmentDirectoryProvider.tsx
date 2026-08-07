import type { ConnectPresence } from "@glass/contracts/connect";
import type { ExecutionEnvironment } from "@glass/contracts/environments";
import type { OrganizationId } from "@glass/contracts/ids";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { listEnvironments, loadEnvironmentPresence } from "../cloud/environments.ts";
import { resolveApiBaseUrl } from "../cloud/transport.ts";
import { errorMessage } from "../lib/errors.ts";

type EnvironmentDirectoryValue = Readonly<{
  apiBaseUrl: string;
  environments: readonly ExecutionEnvironment[];
  error: string | null;
  loading: boolean;
  presence: Readonly<Record<string, ConnectPresence>>;
  refresh: () => Promise<void>;
}>;

const EnvironmentDirectoryContext = createContext<EnvironmentDirectoryValue | null>(null);

export const EnvironmentDirectoryProvider = ({
  children,
  organizationId,
}: Readonly<{ children: ReactNode; organizationId: OrganizationId | null }>) => {
  const apiBaseUrl = useMemo(() => resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL), []);
  const [environments, setEnvironments] = useState<readonly ExecutionEnvironment[]>([]);
  const [presence, setPresence] = useState<Readonly<Record<string, ConnectPresence>>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    if (organizationId === null) {
      setEnvironments([]);
      setPresence({});
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const items = await listEnvironments(apiBaseUrl, organizationId);
      const states = await Promise.all(
        items
          .filter((item) => item.revokedAt === null)
          .map(async (item) => {
            try {
              return [
                item.id,
                await loadEnvironmentPresence(apiBaseUrl, organizationId, item.id),
              ] as const;
            } catch {
              return null;
            }
          }),
      );
      setEnvironments(items);
      setPresence(Object.fromEntries(states.filter((state) => state !== null)));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, organizationId]);

  useEffect(() => {
    void refresh();
    if (organizationId === null) return;
    const handle = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(handle);
  }, [organizationId, refresh]);

  const value = useMemo(
    () => ({ apiBaseUrl, environments, error, loading, presence, refresh }),
    [apiBaseUrl, environments, error, loading, presence, refresh],
  );
  return (
    <EnvironmentDirectoryContext.Provider value={value}>
      {children}
    </EnvironmentDirectoryContext.Provider>
  );
};

export const useEnvironmentDirectory = () => {
  const value = useContext(EnvironmentDirectoryContext);
  if (value === null) throw new Error("EnvironmentDirectoryProvider is missing.");
  return value;
};
