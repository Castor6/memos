import { type ReactNode, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useInstance } from "@/contexts/InstanceContext";
import { finishStartup } from "@/utils/startup";

const StartupReady = ({
  children,
  waitForSettings = true,
  success = true,
}: {
  children?: ReactNode;
  waitForSettings?: boolean;
  success?: boolean;
}) => {
  const { isIdentityInitialized, isInitialized: authInitialized } = useAuth();
  const { isProfileInitialized, isInitialized: instanceInitialized } = useInstance();
  const ready = waitForSettings ? authInitialized && instanceInitialized : isIdentityInitialized && isProfileInitialized;

  useEffect(() => {
    if (ready) finishStartup(success);
  }, [ready, success]);

  return children;
};

export default StartupReady;
