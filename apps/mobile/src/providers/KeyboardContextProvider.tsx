import type { ReactNode } from "react";
import { KeyboardProvider } from "react-native-keyboard-controller";

type KeyboardContextProviderProps = Readonly<{
  children: ReactNode;
}>;

export const KeyboardContextProvider = ({ children }: KeyboardContextProviderProps) => (
  <KeyboardProvider>{children}</KeyboardProvider>
);
