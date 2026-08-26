import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, MapPin, RefreshCw, Store } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { fetchLocalRestockState, type LocalObservation, type LocalRestockState } from '@/lib/local-state';

function ageMinutes(iso: string) {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
}

function providerLabel(health: string) {
  switch (health) {
    case 'ok': return 'Automatic';
    case 'needs_setup': return 'Needs setup';
    case 'manual_only': return 'Manual only';
    case 'rate_limited_or_auth': return 'API issue';
    case 'error': return 'Error';
    default: return 'Checking';
  }
}

function providerClass(health: string) {
  if (health === 'ok') return 'bg-status-live/15 text-status-live ring-status-live/40';
  if (health === 'error' || health === 'rate_limited_or_auth') return 'bg-status-blocked/15 text-status-blocked ring-status-blocked/30';
  return 'bg-status-soon/15 text-status-soon ring-status-soon/30';
}

function ObservationRow({ observation }: { observation: LocalObservation }) {
  return (
    <li className="rounded-xl bg-secondary/50 p-3 ring-1 ring-border">
      <div className="flex items-center gap-2">
        <MapPin className="size-4 shrink-0 text-status-live" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{observation.productName}</span>
        <span className="rounded-full bg-status-live/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-status-live ring-1 ring-status-live/40">
          {observation.lowStock ? 'Low stock' : 'In stock'}
        </span>
      </div>
      <div className="mt-2 text-xs">
        <p className="font-semibold">{observation.storeName} · {observation.distanceMiles.toFixed(1)} mi</p>
        <p className="text-muted-foreground">
          {[observation.address, observation.city, observation.region, observation.postalCode].filter(Boolean).join(', ')}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Official retailer signal · observed {new Date(observation.observedAt).toLocaleTimeString()}
        </p>
      </div>
      {observation.productUrl && (
        <Button asChild size="sm" variant="secondary" className="mt-2 w-full">
          <a href={observation.productUrl} target="_blank" rel="noreferrer noopener">
            <ExternalLink /> Open product
          </a>
        </Button>
      )}
    </li>
  );
}

export function LocalRestockPanel() {
  const [state, setState] = useState<LocalRestockState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await fetchLocalRestockState();
      setState(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load local restock state');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(true), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const sorted = useMemo(
    () => [...(state?.observations ?? [])].sort((a, b) => a.distanceMiles - b.distanceMiles || a.productName.localeCompare(b.productName)),
    [state]
  );

  const stale = state ? ageMinutes(state.updatedAt) > 10 : false;

  return (
    <section className="pack-card mb-5 overflow-hidden rounded-2xl">
      <div className="holo-strip h-1 w-full opacity-70" />
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Store className="size-4" /> Nearby restocks
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {state ? `${state.zone.radiusMiles} miles around ${state.zone.postalCode} · ${state.zone.label}` : 'Local store inventory'}
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>

        {state && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-secondary/50 p-2 text-center ring-1 ring-border">
              <p className="text-lg font-bold">{state.summary.productsWithLocalStock}</p>
              <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Products</p>
            </div>
            <div className="rounded-xl bg-secondary/50 p-2 text-center ring-1 ring-border">
              <p className="text-lg font-bold">{state.summary.storesWithStock}</p>
              <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Stores</p>
            </div>
            <div className="rounded-xl bg-secondary/50 p-2 text-center ring-1 ring-border">
              <p className="text-lg font-bold">{state.summary.observations}</p>
              <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Hits</p>
            </div>
          </div>
        )}

        {state && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {state.providers.map((provider) => (
              <span key={provider.retailer} className={`rounded-full px-2 py-1 text-[10px] font-semibold ring-1 ${providerClass(provider.health)}`}>
                {provider.retailer}: {providerLabel(provider.health)}
              </span>
            ))}
          </div>
        )}

        {(error || stale) && (
          <div className="mt-3 flex gap-2 rounded-xl border border-status-blocked/40 bg-status-blocked/10 p-3 text-xs">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-blocked" />
            <span>{error || `Local inventory state is ${ageMinutes(state!.updatedAt)} minutes old; treat it as stale.`}</span>
          </div>
        )}

        <ul className="mt-3 space-y-2">
          {sorted.map((observation) => (
            <ObservationRow key={`${observation.productKey}-${observation.retailer}-${observation.storeId}`} observation={observation} />
          ))}
        </ul>

        {state && sorted.length === 0 && (
          <div className="mt-3 rounded-xl bg-secondary/40 p-3 text-xs text-muted-foreground ring-1 ring-border">
            No confirmed local inventory is currently being reported inside this radius. This does not mean every store is out of stock: providers marked Manual only are not being checked automatically.
          </div>
        )}

        {state?.providers.some((p) => p.retailer === 'Best Buy' && p.mode === 'official_api') && (
          <div className="mt-4 border-t border-border pt-3 text-[10px] text-muted-foreground">
            <p>Best Buy local availability is sourced from the official Best Buy Developer API when configured.</p>
            <a href="https://developer.bestbuy.com" target="_blank" rel="noreferrer noopener" className="mt-2 inline-block">
              <img src="https://developer.bestbuy.com/images/bestbuy-logo.png" alt="Best Buy Developer API" className="h-6 w-auto" />
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
