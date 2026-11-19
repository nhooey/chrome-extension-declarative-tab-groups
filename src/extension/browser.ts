// Which browser runs the extension, from `navigator.userAgentData`: the
// tool serves Google Chrome only, and other Chromium browsers name
// themselves in the brand list too.

/** One entry of `navigator.userAgentData.brands` or of its `fullVersionList`. */
export type Brand = { readonly brand: string; readonly version: string };

export const GOOGLE_CHROME = "Google Chrome";

/** Whether the brand list is Google Chrome's: it names "Google Chrome", which Chromium, Brave and Edge do not. */
export const isGoogleChrome = (brands: readonly Brand[]): boolean =>
  brands.some((brand) => brand.brand === GOOGLE_CHROME);

/**
 * Google Chrome's version from the most precise list given: the full
 * version list when there is one, else the brands' major version; "unknown"
 * when neither names Google Chrome.
 */
export const chromeVersion = (
  fullVersionList: readonly Brand[] | undefined,
  brands: readonly Brand[],
): string =>
  [...(fullVersionList ?? []), ...brands].find(
    (brand) => brand.brand === GOOGLE_CHROME,
  )?.version ?? "unknown";
