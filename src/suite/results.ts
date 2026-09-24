export function queryKey(
  test: string,
  shape: string | null,
  mode: string | null,
  limit: number | null,
  variant: string | null,
): string {
  return [test, shape ?? '-', mode ?? '-', limit ?? '-', variant ?? '-'].join(':');
}
