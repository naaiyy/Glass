export type WebProductDestination = "/auth" | "/workspace";

export const resolveWebProductDestination = ({
  authenticated,
  organizationSelected,
  pathname,
  status,
}: Readonly<{
  authenticated: boolean;
  organizationSelected: boolean;
  pathname: string;
  status: string;
}>): WebProductDestination | null => {
  if (status === "checking-session") return null;
  if (!authenticated) return pathname === "/auth" ? null : "/auth";
  if (pathname === "/organizations") return "/workspace";
  if (!organizationSelected || status === "organization-selection")
    return pathname === "/workspace" ? null : "/workspace";
  return pathname === "/" || pathname === "/auth" ? "/workspace" : null;
};
