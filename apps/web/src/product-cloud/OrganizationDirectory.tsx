import type { OrganizationId, UserId } from "@glass/contracts/ids";
import type { OrganizationMembershipItem } from "@glass/contracts/organizations";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NativeSelect, NativeSelectOption } from "~/components/ui/native-select";
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
    void load(null);
    const refreshWhenCurrent = () => {
      if (document.visibilityState === "visible") void load(null);
    };
    window.addEventListener("focus", refreshWhenCurrent);
    window.addEventListener("online", refreshWhenCurrent);
    document.addEventListener("visibilitychange", refreshWhenCurrent);
    return () => {
      window.removeEventListener("focus", refreshWhenCurrent);
      window.removeEventListener("online", refreshWhenCurrent);
      document.removeEventListener("visibilitychange", refreshWhenCurrent);
    };
  }, [load]);

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
      await load(null);
      setName("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Card className="mt-8" aria-label="Organizations">
      <CardHeader>
        <CardTitle>Organizations</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        {!loaded && error === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading organizations…
          </div>
        ) : null}
        <Label htmlFor="active-organization">Organization</Label>
        <NativeSelect
          disabled={!loaded || items.length === 0}
          id="active-organization"
          onChange={(event) => onSelect(event.target.value as OrganizationId)}
          value={activeOrganizationId ?? ""}
        >
          <NativeSelectOption disabled value="">
            Choose an organization
          </NativeSelectOption>
          {items.map((item) => (
            <NativeSelectOption key={item.organization.id} value={item.organization.id}>
              {item.organization.name} · {item.membership.role}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {loaded && items.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">No organizations yet.</p>
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
