import { type ReactNode, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useInstance } from "@/contexts/InstanceContext";
import { finishStartup } from "@/utils/startup";

const StartupReady = ({ children, waitForSettings = true }: { children?: ReactNode; waitForSettings?: boolean }) => {
  const { isIdentityInitialized, isInitialized: authInitialized } = useAuth();
  const { isProfileInitialized, isInitialized: instanceInitialized } = useInstance();
  const ready = waitForSettings ? authInitialized && instanceInitialized : isIdentityInitialized && isProfileInitialized;

  useEffect(() => {
    if (ready) finishStartup();
  }, [ready]);

  return children;
};

export default StartupReady;
