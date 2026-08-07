import { twMerge } from "tailwind-merge";

export const cn = (...classes: readonly (false | null | string | undefined)[]): string =>
  twMerge(classes.filter(Boolean).join(" "));
