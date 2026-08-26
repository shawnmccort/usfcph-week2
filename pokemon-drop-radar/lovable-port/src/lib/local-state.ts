export type LocalProviderHealth = 'ok' | 'pending' | 'needs_setup' | 'manual_only' | 'rate_limited_or_auth' | 'error';

export type LocalProvider = {
  retailer: string;
  mode: string;
  health: LocalProviderHealth;
  note: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
};

export type LocalObservation = {
  productKey: string;
  productName: string;
  retailer: string;
  sku: string;
  productUrl: string | null;
  storeId: string;
  storeName: string;
  address: string;
  city: string;
  region: string;
  postalCode: string;
  distanceMiles: number;
  status: 'in_stock' | 'low_stock';
  lowStock: boolean;
  observedAt: string;
  source: string;
  confidence: 'official' | 'reported' | 'unknown';
};

export type LocalRestockState = {
  version: number;
  updatedAt: string;
  zone: {
    label: string;
    postalCode: string;
    radiusMiles: number;
  };
  providers: LocalProvider[];
  summary: {
    automaticRetailers: number;
    productsChecked: number;
    productsWithLocalStock: number;
    storesWithStock: number;
    observations: number;
  };
  observations: LocalObservation[];
};

type LocalStateRow = {
  state: LocalRestockState;
  updated_at: string;
};

export async function fetchLocalRestockState(signal?: AbortSignal): Promise<LocalRestockState> {
  const url = import.meta.env['VITE_SUPABASE_URL'];
  const key = import.meta.env['VITE_SUPABASE_PUBLISHABLE_KEY'];
  if (!url || !key) throw new Error('Supabase client configuration is missing');

  const res = await fetch(`${url}/rest/v1/pokemon_local_state?id=eq.current&select=state,updated_at`, {
    cache: 'no-store',
    signal,
    headers: {
      apikey: key,
      accept: 'application/json'
    }
  });
  if (!res.ok) throw new Error(`local state responded ${res.status}`);
  const rows = (await res.json()) as LocalStateRow[];
  if (!rows[0]?.state) throw new Error('No local restock state has been published yet');
  return rows[0].state;
}
