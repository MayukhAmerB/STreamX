import type { paths } from "./generated/schema";

export type ApiPaths = paths;
export type ApiPath = keyof paths & string;
export type HttpMethod = "delete" | "get" | "patch" | "post" | "put";
export type ApiMethod<Path extends ApiPath> = Extract<keyof paths[Path], HttpMethod>;
export type ApiOperation<
  Path extends ApiPath,
  Method extends ApiMethod<Path>,
> = paths[Path][Method];
