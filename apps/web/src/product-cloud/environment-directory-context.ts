import type { ConnectPresence } from "@glass/contracts/connect";
import type { ExecutionEnvironment } from "@glass/contracts/environments";
import { createContext, useContext } from "react";

export type EnvironmentDirectoryValue = Readonly<{
  environments: readonly ExecutionEnvironment[];
  error: string | null;
  loading: boolean;
  presence: Readonly<Record<string, ConnectPresence>>;
  refresh: () => Promise<void>;
}>;

export const EnvironmentDirectoryContext = createContext<EnvironmentDirectoryValue | null>(null);

export const useEnvironmentDirectory = (): EnvironmentDirectoryValue => {
  const value = useContext(EnvironmentDirectoryContext);
  if (value === null) throw new Error("EnvironmentDirectoryProvider is missing.");
  return value;
};
