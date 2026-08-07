export type MobileRouteSet = "auth" | "bootstrap" | "organizations" | "product";

export const resolveMobileRouteSet = ({
  authenticated,
  organizationSelected,
  phase,
}: Readonly<{
  authenticated: boolean;
  organizationSelected: boolean;
  phase:
    | "checking-session"
    | "configuration-required"
    | "live"
    | "offline"
    | "organization-selection"
    | "signed-out"
    | "synchronizing";
}>): MobileRouteSet => {
  if (phase === "checking-session" || phase === "configuration-required") return "bootstrap";
  if (!authenticated) return phase === "offline" ? "bootstrap" : "auth";
  if (phase === "organization-selection" || !organizationSelected) return "organizations";
  return "product";
};
