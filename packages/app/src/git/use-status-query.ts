import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { checkoutStatusQueryKey } from "@/git/query-keys";
import { fetchCheckoutStatus } from "./checkout-status-cache";

export type { CheckoutStatusPayload } from "./checkout-status-cache";

export const CHECKOUT_STATUS_STALE_TIME = 15_000;

interface UseCheckoutStatusQueryOptions {
  serverId: string;
  cwd: string;
  staleTime?: number;
}

export function useCheckoutStatusQuery({
  serverId,
  cwd,
  staleTime = Infinity,
}: UseCheckoutStatusQueryOptions) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: checkoutStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return await fetchCheckoutStatus({ client, serverId, cwd });
    },
    enabled: !!client && isConnected && !!cwd,
    staleTime,
    // Freshness is push-driven (checkout_status_update applied globally) for the
    // default infinite stale window. Callers with a finite window also refresh
    // stale data when they mount.
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
  };
}

/**
 * Subscribe to checkout status updates from the React Query cache without
 * initiating a fetch. Useful for list rows where a parent component prefetches
 * only the visible agents.
 */
export function useCheckoutStatusCacheOnly({ serverId, cwd }: UseCheckoutStatusQueryOptions) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);

  return useQuery({
    queryKey: checkoutStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return await fetchCheckoutStatus({ client, serverId, cwd });
    },
    enabled: false,
    staleTime: CHECKOUT_STATUS_STALE_TIME,
  });
}
