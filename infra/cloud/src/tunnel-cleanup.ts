export const tunnelRequiresDeletion = (tunnel: { readonly deletedAt?: string | null }): boolean =>
  tunnel.deletedAt == null;
