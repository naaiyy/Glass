export type WebProductDestination = "/auth" | "/organizations" | "/workspace";

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
  if (!organizationSelected || status === "organization-selection") {
    return pathname === "/organizations" ? null : "/organizations";
  }
  return pathname === "/" || pathname === "/auth" || pathname === "/organizations"
    ? "/workspace"
    : null;
};
