import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth/auth-provider";
import { ClientError } from "@/lib/errors";
import type { ConnectionStateResult } from "@/lib/messages";
import { sendBackgroundRequest } from "@/lib/runtime-client";

export const CONNECTION_CHECK_TIMEOUT_MS = 30_000;

const DISCONNECTED: ConnectionStateResult = {
  source: null,
  instanceUrl: null,
  version: null,
  displayName: null,
  status: "disconnected",
  verificationError: null,
  isUsingCachedVersion: false,
};

/** Reads sanitized connection diagnostics; saved credentials never leave the worker. */
export function useMemosConnection(source: "active" | "usememos" = "active") {
  const { isSignedIn, user } = useAuth();
  const [connection, setConnection] = useState<ConnectionStateResult>(DISCONNECTED);
  const connectionRef = useRef<ConnectionStateResult>(DISCONNECTED);
  const [isChecking, setIsChecking] = useState(true);
  const generation = useRef(0);

  const runCheck = useCallback(
    async (refresh = true): Promise<ConnectionStateResult> => {
      const currentGeneration = ++generation.current;
      setIsChecking(true);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          sendBackgroundRequest({ type: "GET_CONNECTION_STATE", refresh, source }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new ClientError("extension-error")), CONNECTION_CHECK_TIMEOUT_MS);
          }),
        ]);
        if (!next) throw new ClientError("extension-error");
        if (generation.current === currentGeneration) {
          connectionRef.current = next;
          setConnection(next);
        }
        return next;
      } catch (error) {
        const current = connectionRef.current;
        const unavailable: ConnectionStateResult = {
          source: current.source,
          instanceUrl: current.instanceUrl,
          version: current.version,
          displayName: current.displayName,
          status: "error",
          verificationError:
            error instanceof ClientError ? error.kind : source === "usememos" || isSignedIn ? "auth-unavailable" : "extension-error",
          isUsingCachedVersion: Boolean(current.version),
        };
        if (generation.current === currentGeneration) {
          connectionRef.current = unavailable;
          setConnection(unavailable);
        }
        return unavailable;
      } finally {
        clearTimeout(timeout);
        if (generation.current === currentGeneration) setIsChecking(false);
      }
    },
    [source, isSignedIn],
  );

  useEffect(() => {
    generation.current += 1;
    connectionRef.current = DISCONNECTED;
    setConnection(DISCONNECTED);
    void runCheck(true);
    return () => {
      generation.current += 1;
    };
  }, [runCheck, user?.id]);

  return {
    source: connection.source,
    instanceUrl: connection.instanceUrl,
    version: connection.version,
    displayName: connection.displayName,
    status: connection.status,
    isChecking,
    verificationError: connection.verificationError,
    isUsingCachedVersion: connection.isUsingCachedVersion,
    reverify: useCallback(() => runCheck(true), [runCheck]),
  };
}
