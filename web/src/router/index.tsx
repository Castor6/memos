import type { ComponentType } from "react";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router-dom";
import App from "@/App";
import { ChunkLoadErrorFallback } from "@/components/ErrorBoundary";
import StartupReady from "@/components/StartupReady";
import MainLayout from "@/layouts/MainLayout";
import RootLayout from "@/layouts/RootLayout";
import { lazyWithReload } from "@/utils/lazy";
import {
  LandingRoute,
  RequireAuthRoute,
  RequireFullInitializationRoute,
  RequireGuestRoute,
  RequireInstanceInitializationRoute,
} from "./guards";
import { ROUTES } from "./routes";

// Only a committed leaf page can hand the initial document over to React.
function lazyPage<Props extends object>(load: () => Promise<{ default: ComponentType<Props> }>) {
  return lazyWithReload(async () => {
    const { default: Page } = await load();
    return {
      default: function StartupPage(props: Props) {
        return (
          <StartupReady>
            <Page {...props} />
          </StartupReady>
        );
      },
    };
  });
}

const AdminSignIn = lazyPage(() => import("@/pages/AdminSignIn"));
const About = lazyPage(() => import("@/pages/About"));
const Archived = lazyPage(() => import("@/pages/Archived"));
const AuthCallback = lazyWithReload(() => import("@/pages/AuthCallback"));
const Explore = lazyPage(() => import("@/pages/Explore"));
const Home = lazyWithReload(() => import("@/pages/Home"));
const Inboxes = lazyPage(() => import("@/pages/Inboxes"));
const MemoDetail = lazyWithReload(() => import("@/pages/MemoDetail"));
const NotFound = lazyPage(() => import("@/pages/NotFound"));
const PermissionDenied = lazyPage(() => import("@/pages/PermissionDenied"));
const Attachments = lazyPage(() => import("@/pages/Attachments"));
const Setting = lazyPage(() => import("@/pages/Setting"));
const Shortcuts = lazyPage(() => import("@/pages/Shortcuts"));
const SignIn = lazyPage(() => import("@/pages/SignIn"));
const SignUp = lazyPage(() => import("@/pages/SignUp"));
const UserProfile = lazyWithReload(() => import("@/pages/UserProfile"));

// Backward compatibility alias.
export const Routes = ROUTES;
export { ROUTES };

/**
 * Static route configuration. Exported so tests can assert on the tree shape
 * (e.g. that `/auth/callback` stays outside the guest-only guard subtree) and
 * so integration tests can drive a `createMemoryRouter` over the same tree.
 */
export const routeConfig: RouteObject[] = [
  {
    path: "/",
    element: <App />,
    errorElement: <ChunkLoadErrorFallback />,
    children: [
      {
        path: Routes.AUTH,
        children: [
          // The OAuth callback must run regardless of the current session — an
          // authenticated tab elsewhere must not block it from consuming its
          // one-time OAuth state. Keep it outside the guest-only subtree.
          { path: "callback", element: <AuthCallback /> },
          {
            element: <RequireInstanceInitializationRoute />,
            children: [
              {
                element: <RequireGuestRoute />,
                children: [
                  { path: "", element: <SignIn /> },
                  { path: "admin", element: <AdminSignIn /> },
                  { path: "signup", element: <SignUp /> },
                ],
              },
            ],
          },
        ],
      },
      // Backward compatibility: the old `/home` URL now lives at `/`.
      { path: "home", element: <Navigate to={Routes.HOME} replace /> },
      {
        element: <RootLayout />,
        children: [
          {
            element: <MainLayout />,
            children: [
              {
                element: <LandingRoute />,
                children: [{ index: true, element: <Home /> }],
              },
              {
                element: <RequireInstanceInitializationRoute />,
                children: [{ path: Routes.ABOUT, element: <About /> }],
              },
              { path: Routes.EXPLORE, element: <Explore /> },
              { path: "u/:username", element: <UserProfile /> },
              {
                element: <RequireAuthRoute />,
                children: [
                  { path: Routes.ARCHIVED, element: <Archived /> },
                  { path: "todos", element: <Home isTodo /> },
                  {
                    element: <RequireFullInitializationRoute />,
                    children: [{ path: Routes.SHORTCUTS, element: <Shortcuts /> }],
                  },
                ],
              },
            ],
          },
          { path: "memos/:uid", element: <MemoDetail /> },
          { path: "memos/shares/:token", element: <MemoDetail /> },
          {
            element: <RequireAuthRoute />,
            children: [
              {
                element: <RequireFullInitializationRoute />,
                children: [
                  { path: Routes.ATTACHMENTS, element: <Attachments /> },
                  { path: Routes.INBOX, element: <Inboxes /> },
                  { path: Routes.SETTING, element: <Setting /> },
                ],
              },
            ],
          },
          { path: "403", element: <PermissionDenied /> },
          { path: "404", element: <NotFound /> },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
];

const router = createBrowserRouter(routeConfig);

export default router;
