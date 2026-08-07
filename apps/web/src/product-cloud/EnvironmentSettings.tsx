import type { ExecutionEnvironment } from "@glass/contracts/environments";
import type { OrganizationId } from "@glass/contracts/ids";
import { useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { environmentCloud } from "./environment-cloud.ts";
import { useEnvironmentDirectory } from "./environment-directory-context.ts";

const statusLabel = (environment: ExecutionEnvironment, status: string | undefined) => {
  if (environment.revokedAt !== null) return "Revoked";
  if (status === "online") return "Online";
  if (status === "offline") return "Offline";
  return "Checking";
};

const setupCommand = "npx glass-connect@latest";

export const EnvironmentSettings = ({
  organizationId,
}: Readonly<{ organizationId: OrganizationId }>) => {
  const directory = useEnvironmentDirectory();
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const approve = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await environmentCloud.approve(organizationId, pairingCode.trim().toUpperCase());
      setPairingCode("");
      setMessage("Approved. Glass Connect is publishing the computer and bringing it online.");
      await directory.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not approve this environment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-8 pb-16 pt-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Settings</p>
          <h1 className="text-3xl font-semibold tracking-tight">Environments</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Publish computers with Glass Connect and see whether they are available.
          </p>
        </div>
        <a className={buttonVariants({ className: "min-h-11 px-4" })} href="#publish-computer">
          Publish computer
        </a>
      </header>

      <Card id="publish-computer">
        <CardHeader>
          <CardTitle>Publish a computer</CardTitle>
          <CardDescription>
            Run one command from a project folder. Glass Connect publishes the computer, makes that
            folder available to your projects, and stays connected after approval.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="mb-6 grid gap-4 text-sm leading-6 text-muted-foreground sm:grid-cols-2">
            <li>
              <span className="font-semibold text-foreground">1. Start Glass Connect</span>
              <br />
              Run the command below in the folder you want to use with Glass.
            </li>
            <li>
              <span className="font-semibold text-foreground">2. Approve the code here</span>
              <br />
              Enter the one-time code it displays. The computer then appears on every signed-in
              Glass device in this organization.
            </li>
          </ol>
          <div className="mb-6 flex min-h-12 items-center justify-between gap-3 rounded-lg bg-muted px-4 py-2">
            <code className="min-w-0 overflow-x-auto text-sm">{setupCommand}</code>
            <Button
              className="shrink-0"
              onClick={() => {
                void navigator.clipboard.writeText(setupCommand).then(
                  () => setMessage("Command copied."),
                  () => setMessage("Unable to copy. Select the command and copy it manually."),
                );
              }}
              type="button"
              variant="ghost"
            >
              Copy command
            </Button>
          </div>
          <form className="grid gap-6" onSubmit={(event) => void approve(event)}>
            <div className="grid gap-2 sm:max-w-sm">
              <Label htmlFor="pairing-code">Code shown by Glass Connect</Label>
              <Input
                autoCapitalize="characters"
                className="font-mono uppercase tracking-wider"
                id="pairing-code"
                maxLength={11}
                onChange={(event) => setPairingCode(event.target.value)}
                placeholder="ABCDE-FGHIJ"
                value={pairingCode}
              />
            </div>
            <Button
              className="min-h-11 px-4"
              disabled={busy || pairingCode.trim().length !== 11}
              type="submit"
            >
              {busy ? "Publishing…" : "Publish computer"}
            </Button>
          </form>
          {message === null ? null : (
            <Alert className="mt-4" role="status">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="published-environments" className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold" id="published-environments">
              Published computers
            </h2>
            <p className="text-sm text-muted-foreground">
              Available to every project and signed-in device in this organization.
            </p>
          </div>
          <Button
            disabled={directory.loading}
            onClick={() => void directory.refresh()}
            type="button"
            variant="outline"
          >
            Refresh status
          </Button>
        </div>
        {directory.error === null ? null : (
          <Alert role="alert">
            <AlertDescription>{directory.error}</AlertDescription>
          </Alert>
        )}
        {directory.environments.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="font-medium">No computers published</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Run Glass Connect on a computer, then approve its code above.
              </p>
            </CardContent>
          </Card>
        ) : (
          directory.environments.map((environment) => {
            const status = statusLabel(environment, directory.presence[environment.id]?.status);
            return (
              <Card key={environment.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle>{environment.displayName}</CardTitle>
                      <CardDescription className="mt-1">
                        {environment.platform} · All organization projects
                      </CardDescription>
                    </div>
                    <Badge variant={status === "Online" ? "secondary" : "outline"}>{status}</Badge>
                  </div>
                </CardHeader>
                {environment.revokedAt === null ? (
                  <CardContent>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        void environmentCloud
                          .revoke(environment.id)
                          .then(directory.refresh)
                          .catch((cause: unknown) =>
                            setMessage(
                              cause instanceof Error
                                ? cause.message
                                : "Could not revoke environment.",
                            ),
                          )
                          .finally(() => setBusy(false));
                      }}
                      type="button"
                      variant="destructive"
                    >
                      Revoke computer
                    </Button>
                  </CardContent>
                ) : null}
              </Card>
            );
          })
        )}
      </section>
    </div>
  );
};
