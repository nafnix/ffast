export function redirectOnUnauthorized(status: number, navigate: (path: string) => void) {
  if (status !== 401) return false;
  navigate("/login");
  return true;
}
