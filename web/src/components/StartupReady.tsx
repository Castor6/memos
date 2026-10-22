import { type ReactNode, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useInstance } from "@/contexts/InstanceContext";
import { finishStartup } from "@/utils/startup";

const StartupReady = ({
  children,
  success = true,
  pending = false,
}: {
  children?: ReactNode;
  success?: boolean;
  /** Keeps the startup screen while page-specific content is still loading. */
  pending?: boolean;
}) => {
  const { isInitialized: authInitialized } = useAuth();
  const { isInitialized: instanceInitialized } = useInstance();
  const ready = authInitialized && instanceInitialized && !pending;

  useEffect(() => {
    if (ready) finishStartup(success);
  }, [ready, success]);

  return children;
};

export default StartupReady;
