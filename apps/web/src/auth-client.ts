import { electronProxyClient } from "@better-auth/electron/proxy";
import { createAuthClient } from "better-auth/react";

const apiOrigin = (): string => {
  const configured = import.meta.env.VITE_GLASS_API_URL as string | undefined;
  if (configured === undefined || configured.trim() === "") {
    return window.glassDesktop?.productCloudOrigin ?? window.location.origin;
  }
  return new URL(configured).origin;
};

export const webAuthClient = createAuthClient({
  baseURL: apiOrigin(),
  plugins: [
    electronProxyClient({
      clientID: "glass-desktop",
      protocol: { scheme: "dev.glass.desktop" },
    }),
  ],
});

export const continueDesktopAuthentication = (): ReturnType<typeof setInterval> | undefined => {
  if (window.glassDesktop !== undefined) return undefined;
  return webAuthClient.ensureElectronRedirect();
};

export const signInWithGitHub = async (): Promise<void> => {
  if (window.glassDesktop !== undefined) {
    if (window.requestAuth === undefined) throw new Error("Desktop authentication is unavailable.");
    await window.requestAuth({ provider: "github" });
    return;
  }
  const callback = new URL(window.location.href);
  callback.search = "";
  callback.hash = "";
  const result = await webAuthClient.signIn.social({
    callbackURL: callback.toString(),
    provider: "github",
  });
  if (result.error !== null) throw new Error(result.error.message ?? "GitHub sign-in failed.");
};

export const signOut = async (): Promise<void> => {
  if (window.glassDesktop !== undefined) {
    if (window.signOut === undefined) throw new Error("Desktop sign-out is unavailable.");
    await window.signOut();
    return;
  }
  const result = await webAuthClient.signOut();
  if (result.error !== null) throw new Error(result.error.message ?? "Sign-out failed.");
};
