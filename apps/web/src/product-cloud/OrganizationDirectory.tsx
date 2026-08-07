import type { OrganizationId, UserId } from "@glass/contracts/ids";
import type { OrganizationMembershipItem } from "@glass/contracts/organizations";
import { Building06Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { createProductCloudTransport } from "./transport.ts";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Glass Cloud could not list organizations.";

export const OrganizationDirectory = ({
  activeOrganizationId,
  onBootstrap,
  onSelect,
  userId,
}: Readonly<{
  activeOrganizationId: OrganizationId | null;
  onBootstrap: (name: string) => Promise<void>;
  onSelect: (organizationId: OrganizationId) => void;
  userId: UserId;
}>) => {
  const transport = useMemo(
    () => createProductCloudTransport(import.meta.env.VITE_GLASS_API_URL),
    [],
  );
  const [items, setItems] = useState<readonly OrganizationMembershipItem[]>([]);
  const [nextCursor, setNextCursor] = useState<OrganizationId | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    async (after: OrganizationId | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await transport.listOrganizations(userId, { after, limit: 50 });
        setItems((current) =>
          after === null
            ? page.items
            : [
                ...current,
                ...page.items.filter(
                  (item) =>
                    !current.some((existing) => existing.organization.id === item.organization.id),
                ),
              ],
        );
        setNextCursor(page.nextCursor);
        setLoaded(true);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setLoading(false);
      }
    },
    [transport, userId],
  );

  useEffect(() => {
    let active = true;
    void transport
      .listOrganizations(userId, { after: null, limit: 50 })
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [transport, userId]);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Enter an organization name.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await onBootstrap(trimmed);
    } catch (cause) {
      setError(errorMessage(cause));
      setCreating(false);
    }
  };

  return (
    <Card className="mx-auto mt-12 w-full max-w-3xl" aria-label="Your organizations">
      <CardHeader>
        <CardTitle className="text-lg">Your organizations</CardTitle>
        <CardDescription>Choose where you want to work in Glass Cloud.</CardDescription>
        <CardAction>
          <Button disabled={loading} onClick={() => void load(null)} size="sm" variant="outline">
            {loading ? (
              <Spinner />
            ) : (
              <HugeiconsIcon icon={Refresh01Icon} data-icon="inline-start" strokeWidth={2} />
            )}
            Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5">
        {!loaded && error === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading organizations…
          </div>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          {items.map((item) => (
            <Button
              className="h-auto min-h-14 justify-between px-3 py-2 text-left"
              key={item.organization.id}
              onClick={() => onSelect(item.organization.id)}
              type="button"
              variant={item.organization.id === activeOrganizationId ? "secondary" : "outline"}
            >
              <span className="min-w-0 truncate">{item.organization.name}</span>
              <Badge variant="outline">{item.membership.role}</Badge>
            </Button>
          ))}
        </div>
        {loaded && items.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={Building06Icon} />
              </EmptyMedia>
              <EmptyTitle>No organizations yet</EmptyTitle>
              <EmptyDescription>Create one below to start working in Glass.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {nextCursor === null ? null : (
          <Button
            className="justify-self-start"
            disabled={loading}
            onClick={() => void load(nextCursor)}
            type="button"
            variant="outline"
          >
            {loading ? "Loading…" : "Load more"}
          </Button>
        )}
        <form className="grid gap-2 border-t pt-5" onSubmit={(event) => void create(event)}>
          <Label htmlFor="organization-name">Create an organization</Label>
          <div className="flex gap-2">
            <Input
              disabled={creating}
              id="organization-name"
              maxLength={240}
              onChange={(event) => setName(event.target.value)}
              placeholder="Organization name"
              value={name}
            />
            <Button disabled={creating} type="submit">
              {creating ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};
