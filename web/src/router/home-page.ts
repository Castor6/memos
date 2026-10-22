let homePage: Promise<typeof import("@/pages/Home")> | undefined;

// Preloading and React.lazy share the same import, including its failure. Only
// the actual lazy render invokes the existing chunk-error reload handling.
export const loadHomePage = () => (homePage ??= import("@/pages/Home"));

export const preloadInitialHomePage = (pathname: string) => {
  if (/^\/(?:home\/?|todos\/?)?$/.test(pathname)) {
    void loadHomePage().catch(() => {});
  }
};
