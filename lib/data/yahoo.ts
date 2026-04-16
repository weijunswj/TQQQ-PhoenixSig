import { fromUnixTime } from 'date-fns';
import { readJsonCache, writeJsonCache } from './cache';
import { PricePoint } from '@/lib/strategy/types';
import { currentSingaporeRefreshKey } from '@/lib/time/singapore-refresh';

const CACHE_PATH = '.cache/yahoo-daily-v3.json';
const NEW_YORK_CLOSE_CONFIRM_MINUTE = (16 * 60) + 15;

type YahooRow = {
  t: number;
  o: number;
  c: number;
  h: number;
};

type CacheShape = {
  key: string;
  data: Record<string, PricePoint[]>;
  liveData?: Record<string, PricePoint[]>;
  retryState?: {
    refreshKey: string;
    failureCount: number;
    nextRetryAtMs: number;
  };
};

export type DailyPricePayload = {
  key: string;
  data: Record<string, PricePoint[]>;
  liveData: Record<string, PricePoint[]>;
  isStaleFallback: boolean;
  nextRetryAtMs: number | null;
};

const RETRY_DELAYS_MS = [5, 10, 30, 60, 120, 240].map((mins) => mins * 60 * 1000);
const formatUtcDate = (date: Date): string => {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const getNewYorkClock = (nowMs: number): { date: string; minuteOfDay: number } => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(nowMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute', string>;

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: (Number(parts.hour) * 60) + Number(parts.minute),
  };
};

const nextRetryDelayMs = (failureCount: number): number => {
  const idx = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, failureCount - 1));
  return RETRY_DELAYS_MS[idx];
};

export const filterToConfirmedDailyCloses = (points: PricePoint[], nowMs = Date.now()): PricePoint[] => {
  if (points.length === 0) return points;

  const latest = points[points.length - 1];
  const newYorkClock = getNewYorkClock(nowMs);

  if (latest.date > newYorkClock.date) {
    return points.slice(0, -1);
  }

  if (latest.date === newYorkClock.date && newYorkClock.minuteOfDay < NEW_YORK_CLOSE_CONFIRM_MINUTE) {
    return points.slice(0, -1);
  }

  return points;
};

const fetchTicker = async (
  ticker: string,
  fromUnix: number,
): Promise<{ confirmed: PricePoint[]; raw: PricePoint[] }> => {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`);
  url.searchParams.set('period1', String(fromUnix));
  url.searchParams.set('period2', String(Math.floor(Date.now() / 1000)));
  url.searchParams.set('interval', '1d');
  url.searchParams.set('events', 'history');

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Yahoo fetch failed for ${ticker}`);

  const json = await res.json();
  if (json.chart?.error) {
    throw new Error(`Yahoo chart error for ${ticker}: ${json.chart.error.description ?? 'unknown error'}`);
  }
  const result = json.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo payload missing result for ${ticker}`);
  }
  const timestamps: number[] = result?.timestamp ?? [];
  const quotes = result?.indicators?.quote?.[0];
  if (!quotes || timestamps.length === 0) {
    throw new Error(`Yahoo payload missing quote rows for ${ticker}`);
  }
  const opens: number[] = quotes?.open ?? [];
  const closes: number[] = quotes?.close ?? [];
  const highs: Array<number | null> = quotes?.high ?? [];

  const rows = timestamps
    .map((t, idx): YahooRow | null => {
      const o = opens[idx];
      const c = closes[idx];
      const h = highs[idx] ?? Math.max(o ?? Number.NEGATIVE_INFINITY, c ?? Number.NEGATIVE_INFINITY);
      if (o == null || c == null) return null;
      return { t, o, c, h };
    })
    .filter((row): row is YahooRow => row !== null)
    .map((row) => ({
      date: formatUtcDate(fromUnixTime(row.t)),
      open: row.o,
      close: row.c,
      high: row.h,
    }));

  return {
    confirmed: filterToConfirmedDailyCloses(rows),
    raw: rows,
  };
};

export const fetchDailyPrices = async (): Promise<DailyPricePayload> => {
  const cacheKey = currentSingaporeRefreshKey();
  const cached = await readJsonCache<CacheShape>(CACHE_PATH);
  if (cached?.key === cacheKey) {
    return {
      key: cached.key,
      data: cached.data,
      liveData: cached.liveData ?? cached.data,
      isStaleFallback: false,
      nextRetryAtMs: null,
    };
  }

  const retryState = cached?.retryState;
  const hasCachedData = Boolean(cached?.data?.TQQQ?.length && cached?.data?.SGOV?.length);
  const isRetryWindowActive = Boolean(
    retryState && retryState.refreshKey === cacheKey && Date.now() < retryState.nextRetryAtMs,
  );

  if (hasCachedData && isRetryWindowActive) {
    return {
      key: cached!.key,
      data: cached!.data,
      liveData: cached!.liveData ?? cached!.data,
      isStaleFallback: true,
      nextRetryAtMs: retryState!.nextRetryAtMs,
    };
  }

  try {
    const fromUnix = Math.floor(Date.UTC(2010, 1, 1) / 1000);
    const [tqqq, sgov] = await Promise.all([fetchTicker('TQQQ', fromUnix), fetchTicker('SGOV', fromUnix)]);
    const data = { TQQQ: tqqq.confirmed, SGOV: sgov.confirmed };
    const liveData = { TQQQ: tqqq.raw, SGOV: sgov.raw };
    const payload = { key: cacheKey, data, liveData };
    await writeJsonCache(CACHE_PATH, payload);
    return { key: payload.key, data: payload.data, liveData, isStaleFallback: false, nextRetryAtMs: null };
  } catch (error) {
    if (hasCachedData) {
      const failureCount = retryState?.refreshKey === cacheKey ? retryState.failureCount + 1 : 1;
      const retryDelayMs = nextRetryDelayMs(failureCount);
      const nextRetryAtMs = Date.now() + retryDelayMs;
      await writeJsonCache(CACHE_PATH, {
        ...cached,
        retryState: {
          refreshKey: cacheKey,
          failureCount,
          nextRetryAtMs,
        },
      });

      return {
        key: cached!.key,
        data: cached!.data,
        liveData: cached!.liveData ?? cached!.data,
        isStaleFallback: true,
        nextRetryAtMs,
      };
    }
    if (error instanceof Error) throw error;
    throw new Error('Failed to fetch Yahoo market data');
  }
};
