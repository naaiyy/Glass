import { useEffect, useState } from "react";

import { signInWithGitHub } from "./auth-client.ts";

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
    <section className="auth-screen" aria-labelledby="auth-title">
      <div className="auth-mark" aria-hidden="true">
        G
      </div>
      <h2 id="auth-title">Welcome to Glass</h2>
      <button className="github-sign-in" disabled={pending} onClick={begin} type="button">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path
            d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.77 2.72 1.26 3.38.96.1-.75.4-1.26.74-1.55-2.57-.29-5.28-1.29-5.28-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.77.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.41-2.72 5.39-5.3 5.68.42.36.79 1.06.79 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"
            fill="currentColor"
          />
        </svg>
        {pending ? "Opening GitHub…" : "Continue with GitHub"}
      </button>
      {error === null ? null : (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
};
