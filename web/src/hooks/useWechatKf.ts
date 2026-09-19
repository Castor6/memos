import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { instanceServiceClient } from "@/connect";
import type { WechatKfSetting } from "@/types/proto/api/v1/instance_service_pb";

export const wechatKfKeys = {
  setting: ["wechat-kf", "setting"] as const,
  status: ["wechat-kf", "status"] as const,
};
export function useWechatKfSetting() {
  return useQuery({ queryKey: wechatKfKeys.setting, queryFn: () => instanceServiceClient.getWechatKfSetting({}) });
}
export function useWechatKfStatus() {
  return useQuery({ queryKey: wechatKfKeys.status, queryFn: () => instanceServiceClient.getWechatKfStatus({}), refetchInterval: 10_000 });
}
export function useSaveWechatKfSetting() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (setting: WechatKfSetting) => instanceServiceClient.updateWechatKfSetting({ setting }),
    onSuccess: (setting) => {
      client.setQueryData(wechatKfKeys.setting, setting);
      void client.invalidateQueries({ queryKey: wechatKfKeys.status });
    },
  });
}
