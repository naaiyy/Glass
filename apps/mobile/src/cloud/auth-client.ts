import { expoClient } from "@better-auth/expo/client";
import type { BetterAuthClientOptions } from "better-auth";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

type MobileAuthClient = ReturnType<typeof createAuthClient> & Readonly<{ getCookie: () => string }>;

const createMobileAuthClient = (apiBaseUrl: string): MobileAuthClient => {
  const nativePlugin = expoClient({
    scheme: "dev.glass.mobile",
    storage: SecureStore,
    storagePrefix: "glass",
  });
  // The integration and Better Auth are pinned together; this isolates a published generic
  // mismatch between their BetterFetch declarations under React Native's library types.
  return createAuthClient({
    baseURL: apiBaseUrl,
    plugins: [nativePlugin] as unknown as BetterAuthClientOptions["plugins"],
  }) as MobileAuthClient;
};

const clients = new Map<string, MobileAuthClient>();

export const getMobileAuthClient = (apiBaseUrl: string) => {
  const existing = clients.get(apiBaseUrl);
  if (existing !== undefined) return existing;
  const client = createMobileAuthClient(apiBaseUrl);
  clients.set(apiBaseUrl, client);
  return client;
};

export const mobileAuthenticatedFetch = (apiBaseUrl: string): typeof fetch => {
  const client = getMobileAuthClient(apiBaseUrl);
  return (input, init) =>
    fetch(input, {
      ...init,
      headers: {
        ...init?.headers,
        cookie: client.getCookie(),
      },
    });
};

export const signInWithGitHub = async (apiBaseUrl: string): Promise<void> => {
  const result = await getMobileAuthClient(apiBaseUrl).signIn.social({
    callbackURL: "/",
    provider: "github",
  });
  if (result.error !== null) throw new Error(result.error.message ?? "GitHub sign-in failed.");
};

export const signOut = async (apiBaseUrl: string): Promise<void> => {
  const result = await getMobileAuthClient(apiBaseUrl).signOut();
  if (result.error !== null) throw new Error(result.error.message ?? "Sign-out failed.");
};
