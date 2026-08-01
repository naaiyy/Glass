import type { ReactNode } from "react";

export type FoundationShellProps = Readonly<{
  children?: ReactNode;
  surface: "desktop" | "web";
}>;

export const FoundationShell = ({ children, surface }: FoundationShellProps) => (
  <main className="foundation-shell">
    <p className="eyebrow">Glass · {surface}</p>
    <h1>Your product stays available when execution disconnects.</h1>
    <p className="lede">
      This foundation renderer connects product state and optional machine capabilities through
      separate boundaries.
    </p>
    {children}
  </main>
);
