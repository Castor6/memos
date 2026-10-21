import { Suspense, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useTranslate } from "@/utils/i18n";
import { lazyWithReload } from "@/utils/lazy";
import { revealStartupShell } from "@/utils/startup";
import { loadHomePage } from "./home-page";

const Home = lazyWithReload(loadHomePage);

const FeedPlaceholder = () => {
  const t = useTranslate();
  const showRecovery = useDelayedFlag(true, 12000);
  return (
    <div data-feed-placeholder>
      <div aria-hidden="true" className="space-y-3">
        <div className="h-56 rounded-xl border border-border bg-card p-4">
          <div className="h-3 w-20 rounded bg-muted" />
          <div className="mt-4 border-t border-border pt-5">
            <div className="h-3 w-32 rounded bg-muted" />
          </div>
        </div>
        {[0, 1].map((row) => (
          <div key={row} className="space-y-4 rounded-xl bg-card p-4">
            <div className="h-3 w-20 rounded bg-muted" />
            <div className="h-3 w-3/4 rounded bg-muted" />
            <div className="h-3 w-1/2 rounded bg-muted" />
          </div>
        ))}
      </div>
      {showRecovery && (
        <div role="status" className="py-6 text-center text-sm text-muted-foreground">
          <p>{t("memo.startup-slow")}</p>
          <Button variant="outline" className="mt-3" onClick={() => window.location.reload()}>
            {t("memo.retry")}
          </Button>
        </div>
      )}
    </div>
  );
};

// This leaf stays inside the identity and private-instance route guards. Its
// local boundary lets navigation and the sidebar commit while Home loads.
const FeedRoute = ({ isTodo = false }: { isTodo?: boolean }) => {
  useEffect(revealStartupShell, []);

  return (
    <Suspense fallback={<FeedPlaceholder />}>
      <Home isTodo={isTodo} />
    </Suspense>
  );
};

export default FeedRoute;
