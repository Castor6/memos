let homePage: Promise<typeof import("@/pages/Home")> | undefined;
let loadedHomePage: typeof import("@/pages/Home") | undefined;

// Preloading and React.lazy share the same import, including its failure. Only
// the actual lazy render invokes the existing chunk-error reload handling.
export const loadHomePage = () =>
  (homePage ??= import("@/pages/Home").then((module) => {
    loadedHomePage = module;
    return module;
  }));

/** Returns the Home module once a preload or earlier render has finished loading it. */
export const getLoadedHomePage = () => loadedHomePage;

export const preloadInitialHomePage = (pathname: string) => {
  if (/^\/(?:home\/?|todos\/?)?$/.test(pathname)) {
    void loadHomePage().catch(() => {});
  }
};
