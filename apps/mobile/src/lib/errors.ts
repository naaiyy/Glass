export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Glass Cloud is unavailable.";
