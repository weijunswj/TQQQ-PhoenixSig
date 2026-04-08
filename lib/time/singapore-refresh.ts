const NEW_YORK_TIME_ZONE = 'America/New_York';
const OPEN_REFRESH_MINUTE = (9 * 60) + 32;
const LAST_CLOSE_REFRESH_MINUTE = (16 * 60) + 45;

export type SingaporeRefreshPhase = 'live-open' | 'last-close';

type PlainDate = {
  year: number;
  month: number;
  day: number;
};

type NewYorkClock = PlainDate & {
  weekday: number;
  hour: number;
  minuteOfDay: number;
};

const isWeekday = (day: number): boolean => day >= 1 && day <= 5;

const plainDateKey = (date: PlainDate): string => {
  const yyyy = date.year;
  const mm = String(date.month).padStart(2, '0');
  const dd = String(date.day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const getNewYorkClock = (nowMs: number): NewYorkClock => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: NEW_YORK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(nowMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  ) as Record<'year' | 'month' | 'day' | 'weekday' | 'hour' | 'minute', string>;

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday] ?? 0,
    hour: Number(parts.hour),
    minuteOfDay: (Number(parts.hour) * 60) + Number(parts.minute),
  };
};

const addDays = (date: PlainDate, delta: number): PlainDate => {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + delta, 12, 0, 0, 0));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

const weekdayForDate = (date: PlainDate): number =>
  new Date(Date.UTC(date.year, date.month - 1, date.day, 12, 0, 0, 0)).getUTCDay();

const shiftTradingDate = (fromDate: PlainDate, step: 1 | -1): PlainDate => {
  let candidate = fromDate;

  do {
    candidate = addDays(candidate, step);
  } while (!isWeekday(weekdayForDate(candidate)));

  return candidate;
};

const parseOffsetMinutes = (offset: string): number => {
  const match = offset.match(/^GMT(?:(\+|-)(\d{1,2})(?::?(\d{2}))?)?$/);
  if (!match || !match[1]) return 0;

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2] ?? '0');
  const minutes = Number(match[3] ?? '0');
  return sign * ((hours * 60) + minutes);
};

const zonedTimeToUtcMs = (date: PlainDate, hour: number, minute: number): number => {
  const guessMs = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0, 0);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK_TIME_ZONE,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const zoneName = formatter
    .formatToParts(new Date(guessMs))
    .find((part) => part.type === 'timeZoneName')
    ?.value ?? 'GMT';

  return guessMs - (parseOffsetMinutes(zoneName) * 60 * 1000);
};

const currentRefreshState = (
  nowMs: number,
): { keyDate: PlainDate; phase: SingaporeRefreshPhase } => {
  const clock = getNewYorkClock(nowMs);
  const today = { year: clock.year, month: clock.month, day: clock.day };

  if (!isWeekday(clock.weekday)) {
    return {
      keyDate: shiftTradingDate(today, -1),
      phase: 'last-close',
    };
  }

  if (clock.minuteOfDay >= LAST_CLOSE_REFRESH_MINUTE) {
    return {
      keyDate: today,
      phase: 'last-close',
    };
  }

  if (clock.minuteOfDay >= OPEN_REFRESH_MINUTE) {
    return {
      keyDate: today,
      phase: 'live-open',
    };
  }

  return {
    keyDate: shiftTradingDate(today, -1),
    phase: 'last-close',
  };
};

export const currentSingaporeRefreshKey = (nowMs: number = Date.now()): string => {
  const clock = getNewYorkClock(nowMs);
  const state = currentRefreshState(nowMs);
  if (state.phase === 'live-open') {
    const hourBucket = String(clock.hour).padStart(2, '0');
    return `${plainDateKey(state.keyDate)}-${state.phase}-${hourBucket}`;
  }
  return `${plainDateKey(state.keyDate)}-${state.phase}`;
};

export const currentSingaporeRefreshPhase = (nowMs: number = Date.now()): SingaporeRefreshPhase =>
  currentRefreshState(nowMs).phase;

export const nextSingaporeRefreshTimeMs = (nowMs: number = Date.now()): number => {
  const clock = getNewYorkClock(nowMs);
  const today = { year: clock.year, month: clock.month, day: clock.day };

  if (isWeekday(clock.weekday) && clock.minuteOfDay < OPEN_REFRESH_MINUTE) {
    return zonedTimeToUtcMs(today, Math.floor(OPEN_REFRESH_MINUTE / 60), OPEN_REFRESH_MINUTE % 60);
  }

  if (isWeekday(clock.weekday) && clock.minuteOfDay < LAST_CLOSE_REFRESH_MINUTE) {
    if (clock.minuteOfDay >= OPEN_REFRESH_MINUTE) {
      const nextHourlyRefreshMinute = (Math.floor(clock.minuteOfDay / 60) + 1) * 60;
      const nextMinuteOfDay = Math.min(nextHourlyRefreshMinute, LAST_CLOSE_REFRESH_MINUTE);
      return zonedTimeToUtcMs(today, Math.floor(nextMinuteOfDay / 60), nextMinuteOfDay % 60);
    }

    return zonedTimeToUtcMs(today, Math.floor(LAST_CLOSE_REFRESH_MINUTE / 60), LAST_CLOSE_REFRESH_MINUTE % 60);
  }

  const nextTradingDate = shiftTradingDate(today, 1);
  return zonedTimeToUtcMs(nextTradingDate, Math.floor(OPEN_REFRESH_MINUTE / 60), OPEN_REFRESH_MINUTE % 60);
};

export const msUntilNextSingaporeRefresh = (nowMs: number = Date.now()): number =>
  Math.max(0, nextSingaporeRefreshTimeMs(nowMs) - nowMs);
