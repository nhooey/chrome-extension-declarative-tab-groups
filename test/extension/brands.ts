import type { Brand } from "../../src/extension/browser.ts";

/** `navigator.userAgentData.brands` as each browser gives it. */
export const BRANDS = {
  chrome: [
    { brand: "Google Chrome", version: "142" },
    { brand: "Chromium", version: "142" },
    { brand: "Not_A Brand", version: "99" },
  ],
  brave: [
    { brand: "Chromium", version: "142" },
    { brand: "Brave", version: "142" },
    { brand: "Not_A Brand", version: "24" },
  ],
  edge: [
    { brand: "Microsoft Edge", version: "142" },
    { brand: "Chromium", version: "142" },
    { brand: "Not_A Brand", version: "99" },
  ],
  chromium: [
    { brand: "Chromium", version: "142" },
    { brand: "Not_A Brand", version: "99" },
  ],
} as const satisfies { readonly [browser: string]: readonly Brand[] };
