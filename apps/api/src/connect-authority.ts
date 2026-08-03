import { DurableObject } from "cloudflare:workers";

export interface GlassConnectAuthorityEnv {
  readonly CONNECT_TICKET_SECRET: string;
}

/** Control-plane freshness and proof authority. No execution data traverses this object. */
export class GlassConnectAuthority extends DurableObject<GlassConnectAuthorityEnv> {
  constructor(ctx: DurableObjectState, env: GlassConnectAuthorityEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS connect_proof_challenges (challenge_id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER)",
    );
  }

  async getTicketGeneration(): Promise<number> {
    return (await this.ctx.storage.get<number>("ticketGeneration")) ?? 0;
  }

  async issueNodeProofChallenge(
    environmentId: string,
    organizationId: string,
  ): Promise<Readonly<{ challengeId: string; challenge: string; expiresAt: string }> | null> {
    if ((await this.ctx.storage.get<boolean>("revoked")) === true) return null;
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + 60;
    this.ctx.storage.sql.exec(
      "DELETE FROM connect_proof_challenges WHERE expires_at <= ?",
      issuedAt,
    );
    const active = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) as count FROM connect_proof_challenges WHERE consumed_at IS NULL AND expires_at > ?",
        issuedAt,
      )
      .toArray()[0];
    if (Number(active?.count ?? 0) >= 5) return null;
    const challengeId = crypto.randomUUID();
    const challenge = [
      "glass-connect-control-proof-v1",
      challengeId,
      environmentId,
      organizationId,
      crypto.randomUUID(),
    ].join("\n");
    this.ctx.storage.sql.exec(
      "INSERT INTO connect_proof_challenges (challenge_id, environment_id, challenge, expires_at) VALUES (?, ?, ?, ?)",
      challengeId,
      environmentId,
      challenge,
      expiresAt,
    );
    return { challengeId, challenge, expiresAt: new Date(expiresAt * 1000).toISOString() };
  }

  async consumeNodeProofChallenge(challengeId: string): Promise<string | null> {
    const now = Math.floor(Date.now() / 1000);
    const row = this.ctx.storage.sql
      .exec<{ challenge: string }>(
        "UPDATE connect_proof_challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ? RETURNING challenge",
        now,
        challengeId,
        now,
      )
      .toArray()[0];
    return row?.challenge ?? null;
  }

  async disconnect(): Promise<void> {
    await this.ctx.storage.put("ticketGeneration", (await this.getTicketGeneration()) + 1);
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.put("revoked", true);
    await this.disconnect();
  }
}
