import type { ReactNode } from "react";

export type FoundationShellProps = Readonly<{
  children?: ReactNode;
}>;

export const FoundationShell = ({ children }: FoundationShellProps) => (
  <main className="foundation-shell">{children}</main>
);
