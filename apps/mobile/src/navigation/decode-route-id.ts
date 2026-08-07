import { decodeId } from "@glass/contracts/ids";

export const decodeRouteId = <Id extends string>(value: string, path: string): Id | null => {
  const decoded = decodeId<Id>(value, path);
  return decoded.ok ? decoded.value : null;
};
