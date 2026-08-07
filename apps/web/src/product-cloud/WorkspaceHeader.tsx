import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const WorkspaceHeaderTargetContext = createContext<HTMLElement | null>(null);

export const WorkspaceHeaderTargetProvider = ({
  children,
  target,
}: Readonly<{ children: ReactNode; target: HTMLElement | null }>) => (
  <WorkspaceHeaderTargetContext.Provider value={target}>
    {children}
  </WorkspaceHeaderTargetContext.Provider>
);

export const WorkspaceHeaderContent = ({ children }: Readonly<{ children: ReactNode }>) => {
  const target = useContext(WorkspaceHeaderTargetContext);
  return target === null ? null : createPortal(children, target);
};
