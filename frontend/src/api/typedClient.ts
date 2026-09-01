import type { AxiosRequestConfig, AxiosResponse } from "axios";

import apiClient from "./client";
import type { ApiMethod, ApiPath } from "./contracts";

export function typedApiRequest<
  Path extends ApiPath,
  Method extends ApiMethod<Path>,
>(
  method: Method,
  path: Path,
  config: AxiosRequestConfig = {},
): Promise<AxiosResponse<unknown>> {
  return apiClient.request({
    ...config,
    method: String(method),
    url: path,
  });
}
