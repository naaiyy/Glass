import { useEffect, useState } from "react";
import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { signInWithGitHub } from "./auth-client.ts";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

export const AuthenticationScreen = ({ onSignedIn }: { onSignedIn: () => void }) => {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const query = new URLSearchParams(window.location.search);
    return query.get("error_description") ?? query.get("error");
  });

  useEffect(() => {
    const stopAuthenticated = window.onAuthenticated?.(() => {
      setPending(false);
      onSignedIn();
    });
    const stopError = window.onAuthError?.((context) => {
      setPending(false);
      setError(context.message ?? "GitHub sign-in failed.");
    });
    return () => {
      stopAuthenticated?.();
      stopError?.();
    };
  }, [onSignedIn]);

  const begin = () => {
    setError(null);
    setPending(true);
    void signInWithGitHub().catch((cause: unknown) => {
      setPending(false);
      setError(cause instanceof Error ? cause.message : "GitHub sign-in failed.");
    });
  };

  return (
    <section
      className="-mb-16 flex min-h-dvh items-center justify-center"
      aria-labelledby="auth-title"
    >
      <div className="grid w-full max-w-sm gap-3">
        <h1 className="text-xl font-semibold tracking-tight" id="auth-title">
          Welcome to Glass
        </h1>
        <Button className="w-full" disabled={pending} onClick={begin} size="lg" type="button">
          <HugeiconsIcon icon={GithubIcon} data-icon="inline-start" strokeWidth={2} />
          {pending ? "Opening GitHub…" : "Continue with GitHub"}
        </Button>
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </section>
  );
};
