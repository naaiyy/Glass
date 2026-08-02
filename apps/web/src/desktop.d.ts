interface Window {
  readonly glassDesktop?: import("@glass/contracts/architecture").DesktopHostDescriptor;
  readonly authenticate?: (data: { token: string }) => Promise<void>;
  readonly getUser?: () => Promise<unknown | null>;
  readonly onAuthenticated?: (callback: (user: unknown) => unknown) => () => void;
  readonly onAuthError?: (callback: (context: { message?: string }) => unknown) => () => void;
  readonly onUserUpdated?: (callback: (user: unknown | null) => unknown) => () => void;
  readonly requestAuth?: (options?: { provider?: string }) => Promise<void>;
  readonly signOut?: () => Promise<void>;
}
