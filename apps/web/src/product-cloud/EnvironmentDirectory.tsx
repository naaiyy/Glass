import type { OrganizationId } from "@glass/contracts/ids";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { environmentCloud } from "./environment-cloud.ts";
import {
  EnvironmentDirectoryContext,
  type EnvironmentDirectoryValue,
} from "./environment-directory-context.ts";

export const EnvironmentDirectoryProvider = ({
  children,
  organizationId,
}: Readonly<{ children: ReactNode; organizationId: OrganizationId | null }>) => {
  const [environments, setEnvironments] = useState<EnvironmentDirectoryValue["environments"]>([]);
  const [presence, setPresence] = useState<EnvironmentDirectoryValue["presence"]>({});
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
      const items = await environmentCloud.list(organizationId);
      const states = await Promise.all(
        items
          .filter((item) => item.revokedAt === null)
          .map(async (item) => {
            try {
              return [item.id, await environmentCloud.presence(organizationId, item.id)] as const;
            } catch {
              return null;
            }
          }),
      );
      setEnvironments(items);
      setPresence(Object.fromEntries(states.filter((state) => state !== null)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load execution environments.");
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void refresh();
    if (organizationId === null) return;
    const handle = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(handle);
  }, [organizationId, refresh]);

  const value = useMemo(
    () => ({ environments, error, loading, presence, refresh }),
    [environments, error, loading, presence, refresh],
  );
  return (
    <EnvironmentDirectoryContext.Provider value={value}>
      {children}
    </EnvironmentDirectoryContext.Provider>
  );
};
