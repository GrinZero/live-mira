let currentTrace = '';
export function rememberTrace(id: string) {
  currentTrace = id;
}
export function currentTraceId() {
  return currentTrace;
}
export async function diagnosticsRequest(suffix = '') {
  const response = await fetch(`/api/diagnostics${suffix}`, {
    headers: { 'x-mira-client-token': localStorage.getItem('mira.ct') || '' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`诊断读取失败（${response.status}）`);
  return response;
}
