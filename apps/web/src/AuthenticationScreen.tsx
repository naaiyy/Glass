import { useEffect, useState } from "react";
import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { signInWithGitHub } from "./auth-client.ts";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";

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
    <Card
      className="mx-auto mt-[clamp(4rem,14vh,9rem)] w-full max-w-sm"
      aria-labelledby="auth-title"
    >
      <CardHeader className="gap-2">
        <div
          className="grid size-9 place-items-center rounded-md bg-primary text-sm font-semibold text-primary-foreground"
          aria-hidden="true"
        >
          G
        </div>
        <CardTitle className="text-xl" id="auth-title">
          Welcome to Glass
        </CardTitle>
        <CardDescription>
          Sign in to continue to your organizations and cloud workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Button className="w-full" disabled={pending} onClick={begin} size="lg" type="button">
          <HugeiconsIcon icon={GithubIcon} data-icon="inline-start" strokeWidth={2} />
          {pending ? "Opening GitHub…" : "Continue with GitHub"}
        </Button>
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};
