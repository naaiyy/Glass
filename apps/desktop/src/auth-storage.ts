import ElectronStore from "electron-store";

type DesktopAuthValues = Record<string, unknown>;

/** Better Auth's durable string storage, owned by Electron's user-data directory. */
export const createDesktopAuthStorage = () => {
  const store = new ElectronStore<DesktopAuthValues>({ name: "auth" });

  return {
    getItem: (key: string): unknown | null => store.get(key) ?? null,
    setItem: (key: string, value: unknown): void => store.set(key, value),
  };
};
