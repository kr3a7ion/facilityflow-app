/**
 * One fetch wrapper. Sessions are httpOnly cookies, so every call carries credentials
 * and nothing ever touches localStorage.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public issues?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline',
      'The server did not answer. Check that you are on the office network and that the host PC is on.');
  }

  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(data.error ?? 'error'),
      String(data.message ?? 'Something went wrong.'),
      data.issues
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export const qk = {
  me: ['me'] as const,
  plant: ['plant'] as const,
  dashboard: ['dashboard'] as const,
  jobs: (q: string) => ['jobs', q] as const,
  job: (id: string) => ['job', id] as const,
  assignable: ['assignable'] as const,
  roster: ['roster'] as const,
  apartments: ['apartments'] as const,
  tanks: ['tanks'] as const,
  deliveries: ['deliveries'] as const,
  runs: ['runs'] as const,
  notifications: ['notifications'] as const,
  handoverDraft: ['handover-draft'] as const,
  stock: ['stock'] as const,
  assets: ['assets'] as const,
  asset: (id: string) => ['asset', id] as const,
  assetCategories: ['asset-categories'] as const,
  locations: ['locations'] as const,
  staff: ['staff'] as const,
  ppmSchedules: ['ppm-schedules'] as const,
  ppmCompliance: ['ppm-compliance'] as const,
  checklists: ['checklists'] as const,
  permits: ['permits'] as const,
  incidents: ['incidents'] as const,
  meters: ['meters'] as const,
  vendors: ['vendors'] as const,
  costCentres: ['cost-centres'] as const,
  budgets: (year: number, month: number) => ['budgets', year, month] as const,
  purchases: ['purchases'] as const,
  expenses: ['expenses'] as const,
  requisitions: ['requisitions'] as const,
  stockCounts: ['stock-counts'] as const,
  stockCount: (id: string) => ['stock-count', id] as const,
  rings: ['my-rings'] as const,
  emergency: ['emergency'] as const,
  ringable: ['ringable'] as const,
};
