import type { OrganizationId, UserId } from "@glass/contracts/ids";
import type { OrganizationMembershipItem } from "@glass/contracts/organizations";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

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
    <section className="organization-directory" aria-label="Your organizations">
      <header>
        <div>
          <p className="section-label">Glass Cloud</p>
          <h2>Your organizations</h2>
        </div>
        <button disabled={loading} onClick={() => void load(null)} type="button">
          Refresh
        </button>
      </header>
      {!loaded && error === null ? <p className="empty-copy">Loading organizations…</p> : null}
      <div className="organization-list">
        {items.map((item) => (
          <button
            className="organization-option"
            data-active={item.organization.id === activeOrganizationId ? "true" : undefined}
            key={item.organization.id}
            onClick={() => onSelect(item.organization.id)}
            type="button"
          >
            <strong>{item.organization.name}</strong>
            <span>{item.membership.role}</span>
          </button>
        ))}
      </div>
      {loaded && items.length === 0 ? <p className="empty-copy">No organizations yet.</p> : null}
      {nextCursor === null ? null : (
        <button disabled={loading} onClick={() => void load(nextCursor)} type="button">
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
      <form className="organization-create" onSubmit={(event) => void create(event)}>
        <label htmlFor="organization-name">Create an organization</label>
        <div>
          <input
            disabled={creating}
            id="organization-name"
            maxLength={240}
            onChange={(event) => setName(event.target.value)}
            placeholder="Organization name"
            value={name}
          />
          <button disabled={creating} type="submit">
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
      {error === null ? null : <p className="field-error">{error}</p>}
    </section>
  );
};
