import type { ReactNode } from "react";

export type FoundationShellProps = Readonly<{
  children?: ReactNode;
}>;

export const FoundationShell = ({ children }: FoundationShellProps) => (
  <main className="foundation-shell mx-auto min-h-dvh w-full max-w-6xl px-4 pb-16 sm:px-6">
    {children}
  </main>
);
