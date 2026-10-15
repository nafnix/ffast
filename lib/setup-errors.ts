export const setupErrorMessages = {
  origin: "请求来源无效。",
  initialized: "服务已初始化，请登录。",
  request: "请求内容无效。",
  mismatch: "两次输入的密码不一致。",
  password: "密码长度需为 4 到 1024 个字符。",
} as const;

export type SetupErrorCode = keyof typeof setupErrorMessages;

export function isSetupErrorCode(value: string | undefined): value is SetupErrorCode {
  return value !== undefined && Object.hasOwn(setupErrorMessages, value);
}
