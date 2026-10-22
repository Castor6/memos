import { type ReactNode, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useInstance } from "@/contexts/InstanceContext";
import { finishStartup } from "@/utils/startup";

const StartupReady = ({ children }: { children?: ReactNode }) => {
  const { isInitialized: authInitialized } = useAuth();
  const { isInitialized: instanceInitialized } = useInstance();

  useEffect(() => {
    if (authInitialized && instanceInitialized) finishStartup();
  }, [authInitialized, instanceInitialized]);

  return children;
};

export default StartupReady;
